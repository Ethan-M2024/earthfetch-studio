"""earthfetch Studio: any place on Earth to a finished map in the browser."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import tempfile
import time
from collections import OrderedDict
from pathlib import Path

import earthfetch as ef
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .render import MAX_AREA_KM2, PRODUCTS, StudioError, bbox_area_km2, render

log = logging.getLogger("studio")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

STATIC = Path(__file__).parent / "static"
app = FastAPI(title="earthfetch Studio", docs_url="/api/docs", redoc_url=None)

#: two renders at once; the rest queue (keeps a free CPU Space responsive)
_slots = asyncio.Semaphore(2)
#: recent results, so re-opening a map or downloading it is instant
_CACHE: OrderedDict[str, dict] = OrderedDict()
_CACHE_SIZE = 40


class RenderRequest(BaseModel):
    product: str
    bbox: list[float] = Field(min_length=4, max_length=4)
    options: dict = Field(default_factory=dict)


def _key(req: RenderRequest) -> str:
    bbox = [round(v, 5) for v in req.bbox]
    blob = json.dumps([req.product, bbox, req.options], sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def _to_web_mercator(rgba: np.ndarray, transform, crs):
    """Warp an RGBA image to EPSG:3857 so Leaflet can pin it exactly.

    Returns the warped image and its [[south, west], [north, east]] bounds.
    """
    from rasterio.enums import Resampling
    from rasterio.transform import Affine, array_bounds
    from rasterio.warp import calculate_default_transform, reproject, transform_bounds

    _, h, w = rgba.shape
    src_tf = Affine(*transform)
    left, bottom, right, top = array_bounds(h, w, src_tf)
    dst_tf, dw, dh = calculate_default_transform(crs, "EPSG:3857", w, h,
                                                 left, bottom, right, top)
    out = np.zeros((4, dh, dw), dtype="uint8")
    for b in range(4):
        reproject(rgba[b], out[b], src_transform=src_tf, src_crs=crs,
                  dst_transform=dst_tf, dst_crs="EPSG:3857",
                  resampling=Resampling.nearest if b == 3 else Resampling.bilinear)
    l2, b2, r2, t2 = array_bounds(dh, dw, dst_tf)
    west, south, east, north = transform_bounds("EPSG:3857", "EPSG:4326", l2, b2, r2, t2)
    return out, [[south, west], [north, east]]


def _encode(rgba: np.ndarray, fmt: str) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    img = Image.fromarray(np.moveaxis(rgba, 0, -1), "RGBA")
    if fmt == "webp":   # the on-map overlay: a fraction of the PNG's size
        img.save(buf, "WEBP", quality=88, method=4)
    else:
        img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _geotiff(data) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "map.tif"
        ef.to_cog(data, path)
        return path.read_bytes()


def _run(req: RenderRequest) -> dict:
    t0 = time.time()
    res = render(req.product, req.bbox, req.options)
    web, bounds = _to_web_mercator(res.rgba, res.transform, res.crs)
    png = _encode(web, "png")
    entry = {
        "title": res.title,
        "bounds": bounds,
        "code": "import earthfetch as ef\n\n" + res.code,
        "legend": res.legend.__dict__ if res.legend else None,
        "meta": {k: v for k, v in res.meta.items() if v not in (None, "")},
        "seconds": round(time.time() - t0, 1),
        "_png": png,
        "_webp": _encode(web, "webp"),
        "_tif": _geotiff(res.data),
    }
    log.info("%s %s: %.1fs, overlay %d KB", req.product, req.bbox, entry["seconds"],
             len(entry["_webp"]) // 1024)
    return entry


@app.get("/api/health")
def health():
    return {"ok": True, "earthfetch": ef.__version__}


@app.get("/api/products")
def products():
    return {"products": list(PRODUCTS), "max_area_km2": MAX_AREA_KM2}


@app.get("/api/geocode")
def geocode(q: str = Query(min_length=2, max_length=200)):
    try:
        a = ef.geocode(q)
    except ef.EarthfetchError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"name": a.name, "bbox": list(a.bbox)}


@app.post("/api/render")
async def render_map(req: RenderRequest):
    key = _key(req)
    if key not in _CACHE:
        async with _slots:
            try:
                entry = await asyncio.to_thread(_run, req)
            except StudioError as exc:
                raise HTTPException(422, str(exc)) from exc
            except Exception as exc:  # upstream outage, odd geometry, ...
                log.exception("render failed")
                raise HTTPException(
                    502, "the data service didn't answer; try again in a minute"
                ) from exc
        _CACHE[key] = entry
        while len(_CACHE) > _CACHE_SIZE:
            _CACHE.popitem(last=False)
    _CACHE.move_to_end(key)
    entry = _CACHE[key]
    body = {k: v for k, v in entry.items() if not k.startswith("_")}
    body["id"] = key
    body["image"] = f"/api/image/{key}.webp"
    body["area_km2"] = round(bbox_area_km2(req.bbox), 1)
    return JSONResponse(body)


@app.get("/api/image/{key}.webp")
def overlay_image(key: str):
    entry = _CACHE.get(key)
    if not entry:
        raise HTTPException(404, "that map expired; render it again")
    return Response(entry["_webp"], media_type="image/webp",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/download/{key}.tif")
def download_tif(key: str):
    entry = _CACHE.get(key)
    if not entry:
        raise HTTPException(404, "that map expired; render it again")
    return Response(entry["_tif"], media_type="image/tiff",
                    headers={"Content-Disposition": f'attachment; filename="earthfetch_{key}.tif"'})


@app.get("/api/download/{key}.png")
def download_png(key: str):
    entry = _CACHE.get(key)
    if not entry:
        raise HTTPException(404, "that map expired; render it again")
    return Response(entry["_png"], media_type="image/png",
                    headers={"Content-Disposition": f'attachment; filename="earthfetch_{key}.png"'})


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
