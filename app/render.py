"""Turn an area and a product choice into a map image, a GeoTIFF, and the
earthfetch code that reproduces it."""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field

import earthfetch as ef
import numpy as np

#: longest side of a rendered map, in pixels; bounds the work per request
MAX_PIXELS = 1400
#: largest area served, in km², per product (radar and composites read many
#: scenes, so they get smaller limits)
MAX_AREA_KM2 = {"satellite": 150, "ndvi": 150, "radar": 150, "water": 150,
                "terrain": 400, "rem": 120, "aerial": 40}


@dataclass
class Legend:
    label: str
    vmin: float
    vmax: float
    colors: list[str]
    kind: str = "ramp"          # "ramp" or "swatch"


@dataclass
class Result:
    rgba: np.ndarray                 # (4, h, w) uint8 in ``crs``
    transform: tuple
    crs: str
    data: object                     # xarray object written to the GeoTIFF
    code: str
    title: str
    legend: Legend | None = None
    meta: dict = field(default_factory=dict)


class StudioError(Exception):
    """A request we can explain to the user (too big, no data, ...)."""


def bbox_area_km2(bbox) -> float:
    w, s, e, n = bbox
    lat = math.radians((s + n) / 2)
    return abs(e - w) * 111.32 * math.cos(lat) * abs(n - s) * 110.57


def _res_for(bbox, native_m: float) -> float:
    """Pixel size (m) that keeps the longest side under ``MAX_PIXELS``."""
    w, s, e, n = bbox
    lat = math.radians((s + n) / 2)
    span = max(abs(e - w) * 111_320 * math.cos(lat), abs(n - s) * 110_570)
    return max(native_m, math.ceil(span / MAX_PIXELS))


def _dates(opts) -> tuple[str, str]:
    end = opts.get("end") or dt.date.today().isoformat()
    start = opts.get("start") or (
        dt.date.fromisoformat(end) - dt.timedelta(days=90)).isoformat()
    return start, end


def _ramp(cmap: str, n: int = 9) -> list[str]:
    import matplotlib

    cm = matplotlib.colormaps[cmap]
    return ["#%02x%02x%02x" % tuple(int(255 * c) for c in cm(i / (n - 1))[:3])
            for i in range(n)]


def _colorize(band, cmap, lo, hi, shade=None) -> np.ndarray:
    import matplotlib

    band = np.asarray(band, dtype="float32")
    norm = np.clip((band - lo) / ((hi - lo) or 1.0), 0, 1)
    rgb = matplotlib.colormaps[cmap](np.nan_to_num(norm))[..., :3]
    if shade is not None:
        hs = np.nan_to_num(np.asarray(shade, dtype="float32") / 255.0, nan=1.0)
        rgb = rgb * (0.45 + 0.55 * hs[..., None])
    alpha = np.isfinite(band)
    return _pack(np.moveaxis(rgb, -1, 0), alpha)


def _stretch(rgb, lo_pct=2, hi_pct=98) -> np.ndarray:
    rgb = np.asarray(rgb, dtype="float32")
    finite = rgb[np.isfinite(rgb)]
    if finite.size == 0:
        raise StudioError("no valid pixels in this area")
    lo, hi = np.percentile(finite, (lo_pct, hi_pct))
    out = np.clip((rgb - lo) / ((hi - lo) or 1.0), 0, 1)
    return _pack(np.nan_to_num(out), np.isfinite(rgb).all(axis=0))


def _pack(rgb01, alpha_mask) -> np.ndarray:
    rgba = np.empty((4, *rgb01.shape[1:]), dtype="uint8")
    rgba[:3] = (np.clip(rgb01, 0, 1) * 255).astype("uint8")
    rgba[3] = np.where(alpha_mask, 255, 0).astype("uint8")
    return rgba


def _georef(obj):
    return tuple(obj.attrs["transform"]), obj.attrs["crs"]


def _bbox_code(bbox) -> str:
    return "(" + ", ".join(f"{v:.4f}" for v in bbox) + ")"


# ------------------------------------------------------------------ products

def _satellite(bbox, opts):
    start, end = _dates(opts)
    res = _res_for(bbox, 10)
    rgb = ef.composite(bbox, bands=["B04", "B03", "B02"], start=start, end=end,
                       res=res, max_scenes=6)
    tf, crs = _georef(rgb)
    code = (f"rgb = ef.composite({_bbox_code(bbox)}, bands=['B04', 'B03', 'B02'],\n"
            f"                   start='{start}', end='{end}')\n"
            "ef.preview(rgb, 'satellite.png')")
    return Result(_stretch(rgb.values), tf, crs, rgb, code,
                  "Satellite photo (Sentinel-2)",
                  meta={"dates": f"{start} to {end}", "pixel_m": res})


def _ndvi(bbox, opts):
    start, end = _dates(opts)
    res = _res_for(bbox, 10)
    ds = ef.composite(bbox, bands=["B08", "B04"], start=start, end=end,
                      res=res, max_scenes=6)
    nd = ef.ndvi(ds)
    nd.attrs = {**ds.attrs, **nd.attrs}
    tf, crs = _georef(ds)
    code = (f"ds = ef.composite({_bbox_code(bbox)}, bands=['B08', 'B04'],\n"
            f"                  start='{start}', end='{end}')\n"
            "ndvi = ef.ndvi(ds)\n"
            "ef.preview(ndvi, 'ndvi.png', cmap='RdYlGn', vmin=-0.2, vmax=0.9, legend=True)")
    return Result(_colorize(nd.values, "RdYlGn", -0.2, 0.9), tf, crs, nd, code,
                  "Plant health (NDVI)",
                  Legend("Plant health (NDVI)", -0.2, 0.9, _ramp("RdYlGn")),
                  meta={"dates": f"{start} to {end}", "pixel_m": res,
                        "mean": round(float(np.nanmean(nd.values)), 3)})


def _terrain(bbox, opts):
    resolution = opts.get("resolution") or "10m"
    native = {"1m": 1, "10m": 10, "30m": 30}.get(resolution, 10)
    res = _res_for(bbox, native)
    t = ef.terrain(bbox, products=["dem", "hillshade"], resolution=resolution, res=res)
    dem = t.dem.values
    lo, hi = (float(v) for v in np.nanpercentile(dem, (1, 99)))
    tf, crs = _georef(t)
    code = (f"terr = ef.terrain({_bbox_code(bbox)}, resolution='{resolution}')\n"
            "ef.preview(terr.dem, 'terrain.png', cmap='terrain', shade=terr.hillshade,\n"
            "           legend=True)")
    return Result(_colorize(dem, "terrain", lo, hi, shade=t.hillshade.values), tf,
                  crs, t.dem, code, "Elevation",
                  Legend("Elevation (m)", round(lo), round(hi), _ramp("terrain")),
                  meta={"source": t.attrs.get("source"), "pixel_m": res,
                        "min_m": round(float(np.nanmin(dem)), 1),
                        "max_m": round(float(np.nanmax(dem)), 1)})


def _rem(bbox, opts):
    resolution = opts.get("resolution") or "10m"
    native = {"1m": 2, "10m": 10, "30m": 30}.get(resolution, 10)
    res = _res_for(bbox, native)
    river = (opts.get("river") or "").strip() or None
    vmax = float(opts.get("vmax") or 6)
    try:
        r = ef.rem(bbox, river=river, resolution=resolution, res=res)
    except ef.EarthfetchError as exc:
        raise StudioError(str(exc)) from exc
    tf, crs = _georef(r)
    river_arg = f", river='{river}'" if river else ""
    code = (f"r = ef.rem({_bbox_code(bbox)}{river_arg}, resolution='{resolution}')\n"
            f"ef.preview(r.rem, 'rem.png', cmap='YlGnBu_r', vmin=0, vmax={vmax:g},\n"
            "           shade=r.hillshade, legend=True)")
    return Result(_colorize(r.rem.values, "YlGnBu_r", 0, vmax, shade=r.hillshade.values),
                  tf, crs, r.rem, code, f"Flood-prone ground: {r.attrs.get('river') or 'river'}",
                  Legend("Height above river (m)", 0, vmax, _ramp("YlGnBu_r")),
                  meta={"river": r.attrs.get("river"),
                        "centerline": r.attrs.get("river_source"),
                        "dem": f"{r.attrs.get('source')} {r.attrs.get('resolution')}",
                        "pixel_m": res})


def _radar(bbox, opts):
    start, end = _dates(opts)
    res = _res_for(bbox, 10)
    s1 = ef.load_sentinel1(bbox, polarizations=["VV"], start=start, end=end,
                           method="median", res=res)
    tf, crs = _georef(s1)
    code = (f"s1 = ef.load_sentinel1({_bbox_code(bbox)}, start='{start}', end='{end}',\n"
            "                       method='median')\n"
            "ef.preview(s1.sel(band='VV'), 'radar.png', cmap='gray', vmin=-25, vmax=0,\n"
            "           legend=True)")
    vv = s1.sel(band="VV")
    return Result(_colorize(vv.values, "gray", -25, 0), tf, crs, vv, code,
                  "Radar (Sentinel-1)",
                  Legend("VV backscatter (dB)", -25, 0, _ramp("gray")),
                  meta={"passes": len(s1.attrs.get("dates", [])),
                        "dates": ", ".join(s1.attrs.get("dates", [])[-3:]),
                        "pixel_m": res})


def _water(bbox, opts):
    start, end = _dates(opts)
    res = _res_for(bbox, 10)
    s1 = ef.load_sentinel1(bbox, polarizations=["VV"], start=start, end=end, res=res)
    w = ef.water_mask(s1)
    tf, crs = _georef(s1)
    vals = w.values
    rgba = np.zeros((4, *vals.shape), dtype="uint8")
    rgba[0], rgba[1], rgba[2] = 30, 136, 229
    rgba[3] = np.where(vals == 1, 220, 0)
    code = (f"s1 = ef.load_sentinel1({_bbox_code(bbox)}, start='{start}', end='{end}')\n"
            "water = ef.water_mask(s1)      # 1 = open water, through cloud")
    frac = float(np.nanmean(vals))
    return Result(rgba, tf, crs, w, code, "Water (from radar)",
                  Legend("Open water", 0, 1, ["#1e88e5"], kind="swatch"),
                  meta={"date": s1.attrs.get("datetime", "")[:10],
                        "water_pct": round(100 * frac, 1), "pixel_m": res})


def _aerial(bbox, opts):
    res = _res_for(bbox, 1)
    img = ef.load_naip(bbox, res=res)
    tf, crs = _georef(img)
    code = (f"img = ef.load_naip({_bbox_code(bbox)}, res=1)\n"
            "ef.preview(img, 'aerial.png')")
    return Result(_stretch(img.values, 0.5, 99.5), tf, crs, img, code,
                  "Aerial photo (USDA NAIP)", meta={"pixel_m": res})


PRODUCTS = {
    "satellite": _satellite,
    "ndvi": _ndvi,
    "terrain": _terrain,
    "rem": _rem,
    "radar": _radar,
    "water": _water,
    "aerial": _aerial,
}


def render(product: str, bbox, opts: dict) -> Result:
    if product not in PRODUCTS:
        raise StudioError(f"unknown product {product!r}")
    w, s, e, n = bbox
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise StudioError("draw a box on the map first")
    area = bbox_area_km2(bbox)
    limit = MAX_AREA_KM2[product]
    if area > limit:
        raise StudioError(
            f"that box is {area:,.0f} km²; this map is limited to {limit} km² "
            "here. Draw a smaller box, or run the code below on your own machine "
            "for any size.")
    try:
        return PRODUCTS[product](tuple(bbox), opts or {})
    except StudioError:
        raise
    except ef.NoScenesError as exc:
        raise StudioError(f"no clear scenes found: {exc}. Try a wider date range.") from exc
    except ef.TileNotFoundError as exc:
        raise StudioError(f"no data covers this area: {exc}") from exc
    except ef.EarthfetchError as exc:
        raise StudioError(str(exc)) from exc
