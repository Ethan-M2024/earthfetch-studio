"""Markups in, analyst-ready files out: GeoJSON, Shapefile, KML, CSV, and a
hand-off package that bundles them with the map layers and a plain README."""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import zipfile
from xml.sax.saxutils import escape

import shapefile  # pyshp
from pyproj import Geod

GEOD = Geod(ellps="WGS84")

#: what the PM picked in the "What do you need?" box
REQUESTS = {
    "note": "Just a note",
    "analysis": "Needs analysis",
    "data": "Needs better data",
    "site": "Needs a site visit",
    "question": "Question",
}

WGS84_PRJ = (
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,'
    '298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
)

_KINDS = {"Point": "points", "LineString": "lines", "Polygon": "areas"}


class HandoffError(ValueError):
    pass


# ------------------------------------------------------------------ inputs

def clean_features(fc: dict) -> list[dict]:
    """Validated markup features (Point, LineString, Polygon) with tidy
    properties and measurements filled in."""
    if not isinstance(fc, dict) or fc.get("type") != "FeatureCollection":
        raise HandoffError("expected a GeoJSON FeatureCollection")
    out = []
    for i, f in enumerate(_explode(fc.get("features") or []), start=1):
        g = (f or {}).get("geometry") or {}
        if g.get("type") not in _KINDS:
            continue
        p = dict(f.get("properties") or {})
        props = {
            "id": str(p.get("id") or i),
            "name": str(p.get("name") or f"{g['type']} {i}")[:120],
            "note": str(p.get("note") or ""),
            "request": REQUESTS.get(p.get("request"), p.get("request") or REQUESTS["note"]),
            "created": str(p.get("created") or ""),
            "author": str(p.get("author") or ""),
        }
        props.update(measure(g))
        out.append({"type": "Feature", "geometry": g, "properties": props})
    if not out:
        raise HandoffError("there are no pins, lines, or areas to export yet")
    return out


def _explode(features):
    """Split Multi* geometries into single parts (shapefiles and the markup
    editor both work per part)."""
    for f in features:
        g = (f or {}).get("geometry") or {}
        single = {"MultiPoint": "Point", "MultiLineString": "LineString",
                  "MultiPolygon": "Polygon"}.get(g.get("type"))
        if single:
            for part in g["coordinates"]:
                yield {**f, "geometry": {"type": single, "coordinates": part}}
        else:
            yield f


def measure(geom: dict) -> dict:
    """Geodesic length/area in units a PM uses (and metric for analysts)."""
    t = geom["type"]
    if t == "LineString":
        lon, lat = zip(*[c[:2] for c in geom["coordinates"]], strict=True)
        m = GEOD.line_length(lon, lat)
        return {"length_mi": round(m / 1609.344, 3), "length_km": round(m / 1000, 3)}
    if t == "Polygon":
        ring = geom["coordinates"][0]
        lon, lat = zip(*[c[:2] for c in ring], strict=True)
        area, perim = GEOD.polygon_area_perimeter(lon, lat)
        a = abs(area)
        return {"area_acres": round(a / 4046.8564224, 2), "area_ha": round(a / 1e4, 2),
                "perim_mi": round(perim / 1609.344, 3)}
    lon, lat = geom["coordinates"][:2]
    return {"lon": round(lon, 6), "lat": round(lat, 6)}


# ------------------------------------------------------------------ writers

def to_geojson(features: list[dict], meta: dict | None = None) -> bytes:
    fc = {"type": "FeatureCollection", "features": features}
    if meta:
        fc["properties"] = meta
    return json.dumps(fc, indent=2, ensure_ascii=False).encode()


def to_shapefile_zip(features: list[dict], stem: str = "markups") -> bytes:
    """A zip holding one shapefile per geometry type (points, lines, areas),
    WGS84 .prj files, and UTF-8 .cpg files. Shapefile text fields cap at 254
    characters, so long notes are cut here and kept whole in the CSV/GeoJSON."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for gtype, kind in _KINDS.items():
            group = [f for f in features if f["geometry"]["type"] == gtype]
            if not group:
                continue
            shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
            w = shapefile.Writer(shp=shp, shx=shx, dbf=dbf, encoding="utf-8")
            w.field("ID", "C", 20)
            w.field("NAME", "C", 120)
            w.field("REQUEST", "C", 40)
            w.field("NOTE", "C", 254)
            w.field("AUTHOR", "C", 60)
            w.field("CREATED", "C", 25)
            if gtype == "Polygon":
                w.field("AREA_AC", "N", 14, 2)
                w.field("AREA_HA", "N", 14, 2)
            elif gtype == "LineString":
                w.field("LEN_MI", "N", 14, 3)
                w.field("LEN_KM", "N", 14, 3)
            else:
                w.field("LAT", "N", 12, 6)
                w.field("LON", "N", 12, 6)
            for f in group:
                p, c = f["properties"], f["geometry"]["coordinates"]
                row = [p["id"], p["name"], p["request"], p["note"][:254], p["author"][:60],
                       p["created"][:25]]
                if gtype == "Polygon":
                    w.poly([[pt[:2] for pt in ring] for ring in c])
                    row += [p["area_acres"], p["area_ha"]]
                elif gtype == "LineString":
                    w.line([[pt[:2] for pt in c]])
                    row += [p["length_mi"], p["length_km"]]
                else:
                    w.point(*c[:2])
                    row += [p["lat"], p["lon"]]
                w.record(*row)
            w.close()
            name = f"{stem}_{kind}"
            z.writestr(f"{name}.shp", shp.getvalue())
            z.writestr(f"{name}.shx", shx.getvalue())
            z.writestr(f"{name}.dbf", dbf.getvalue())
            z.writestr(f"{name}.prj", WGS84_PRJ)
            z.writestr(f"{name}.cpg", "UTF-8")
    return buf.getvalue()


def to_kml(features: list[dict], title: str = "Markups") -> bytes:
    """KML for Google Earth: pins, lines, and outlined areas with notes."""
    def coords(pts):
        return " ".join(f"{x},{y},0" for x, y, *_ in pts)

    marks = []
    for f in features:
        g, p = f["geometry"], f["properties"]
        desc = escape(f"{p['request']}\n\n{p['note']}".strip())
        if g["type"] == "Point":
            shape = f"<Point><coordinates>{coords([g['coordinates']])}</coordinates></Point>"
        elif g["type"] == "LineString":
            shape = ("<LineString><coordinates>"
                     f"{coords(g['coordinates'])}</coordinates></LineString>")
        else:
            rings = g["coordinates"]
            inner = "".join(
                f"<innerBoundaryIs><LinearRing><coordinates>{coords(r)}</coordinates>"
                "</LinearRing></innerBoundaryIs>" for r in rings[1:])
            shape = (f"<Polygon><outerBoundaryIs><LinearRing><coordinates>{coords(rings[0])}"
                     f"</coordinates></LinearRing></outerBoundaryIs>{inner}</Polygon>")
        marks.append(f"<Placemark><name>{escape(p['name'])}</name>"
                     f"<description>{desc}</description><styleUrl>#m</styleUrl>{shape}</Placemark>")
    doc = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
           f"<name>{escape(title)}</name>"
           '<Style id="m"><LineStyle><color>ffe0a300</color><width>3</width></LineStyle>'
           '<PolyStyle><color>4000a3e0</color></PolyStyle></Style>'
           + "".join(marks) + "</Document></kml>")
    return doc.encode()


def to_csv(features: list[dict]) -> bytes:
    """One row per markup: the full notes, in a sheet anyone can open."""
    buf = io.StringIO()
    cols = ["id", "type", "name", "request", "note", "author", "created",
            "lat", "lon", "length_mi", "area_acres"]
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for f in features:
        p = dict(f["properties"])
        g = f["geometry"]
        if g["type"] != "Point":   # a representative location for lines and areas
            pts = g["coordinates"][0] if g["type"] == "Polygon" else g["coordinates"]
            p.setdefault("lon", round(sum(c[0] for c in pts) / len(pts), 6))
            p.setdefault("lat", round(sum(c[1] for c in pts) / len(pts), 6))
        p["type"] = {"Point": "pin", "LineString": "line", "Polygon": "area"}[g["type"]]
        w.writerow(p)
    return ("﻿" + buf.getvalue()).encode()   # BOM so Excel reads UTF-8


# ----------------------------------------------------------------- package

def readme(project: dict, features: list[dict], layers: list[dict]) -> str:
    today = dt.date.today().isoformat()
    lines = [
        f"{project.get('name') or 'Untitled project'}",
        "=" * max(20, len(project.get("name") or "")),
        "",
        f"Prepared by: {project.get('author') or 'not given'}",
        f"Date:        {today}",
        "Made with:   earthfetch Studio (https://huggingface.co/spaces/DataDude26/earthfetch-studio)",
        "",
    ]
    if project.get("message"):
        lines += ["Message for the analyst", "-----------------------", project["message"], ""]
    lines += ["Markups", "-------"]
    for f in features:
        p, t = f["properties"], f["geometry"]["type"]
        size = (f"{p['area_acres']} acres" if t == "Polygon"
                else f"{p['length_mi']} mi" if t == "LineString"
                else f"{p['lat']}, {p['lon']}")
        kind = {"Point": "Pin", "LineString": "Line", "Polygon": "Area"}[t]
        lines.append(f"* [{p['request']}] {kind} \"{p['name']}\" ({size})")
        if p["note"]:
            lines += [f"    {ln}" for ln in p["note"].splitlines()]
    lines += ["", "Map layers viewed", "-----------------"]
    if layers:
        for lay in layers:
            lines.append(f"* {lay['title']}  (layers/{lay['file']})")
            for k, v in (lay.get("meta") or {}).items():
                lines.append(f"    {k}: {v}")
    else:
        lines.append("(none)")
    lines += [
        "",
        "Files",
        "-----",
        "markups.geojson        all markups with full notes (WGS84)",
        "shapefile/             markups_points / _lines / _areas .shp (WGS84, EPSG:4326)",
        "markups.kml            open in Google Earth",
        "notes.csv              every note in a spreadsheet",
        "layers/*.tif           the map layers as Cloud-Optimized GeoTIFFs",
        "reproduce_layers.py    earthfetch code that rebuilds every layer",
        "",
        "Shapefile NOTE fields are cut at 254 characters; the GeoJSON and CSV",
        "keep the full text.",
    ]
    return "\n".join(lines) + "\n"


def package(project: dict, features: list[dict], layers: list[dict]) -> bytes:
    """The hand-off zip. ``layers`` entries carry title, file, meta, code,
    and the GeoTIFF bytes under ``tif``."""
    stem = "markups"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.txt", readme(project, features, layers))
        z.writestr(f"{stem}.geojson", to_geojson(features, {
            "project": project.get("name"), "author": project.get("author"),
            "message": project.get("message")}))
        z.writestr(f"{stem}.kml", to_kml(features, project.get("name") or "Markups"))
        z.writestr("notes.csv", to_csv(features))
        with zipfile.ZipFile(io.BytesIO(to_shapefile_zip(features, stem))) as shp:
            for info in shp.infolist():
                z.writestr(f"shapefile/{info.filename}", shp.read(info))
        code = ["import earthfetch as ef", ""]
        for lay in layers:
            z.writestr(f"layers/{lay['file']}", lay["tif"])
            body = lay["code"].replace("import earthfetch as ef\n\n", "")
            code += [f"# {lay['title']}", body, ""]
        if layers:
            z.writestr("reproduce_layers.py", "\n".join(code))
    return buf.getvalue()


# ------------------------------------------------------------------ import

def read_upload(name: str, data: bytes) -> dict:
    """GeoJSON FeatureCollection from an uploaded .geojson/.json or a zipped
    shapefile (e.g. an analyst's reply), reprojection not supported: the
    shapefile must be in WGS84 lon/lat."""
    low = name.lower()
    if low.endswith((".geojson", ".json")):
        fc = json.loads(data.decode("utf-8-sig"))
        if fc.get("type") == "Feature":
            fc = {"type": "FeatureCollection", "features": [fc]}
        return fc
    if low.endswith(".zip"):
        feats = []
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            stems = {n[:-4] for n in z.namelist() if n.lower().endswith(".shp")}
            for s in sorted(stems):
                prj = next((z.read(n).decode(errors="ignore") for n in z.namelist()
                            if n.lower() == f"{s.lower()}.prj"), "")
                if "PROJCS" in prj:
                    raise HandoffError(f"{s}.shp is in a projected coordinate system; "
                                       "export it in WGS84 (EPSG:4326) and try again")
                r = shapefile.Reader(
                    shp=io.BytesIO(z.read(f"{s}.shp")),
                    shx=io.BytesIO(z.read(f"{s}.shx")),
                    dbf=io.BytesIO(z.read(f"{s}.dbf")), encoding="utf-8",
                    encodingErrors="replace")
                names = [fl[0] for fl in r.fields[1:]]
                for sr in r.iterShapeRecords():
                    rec = dict(zip(names, sr.record, strict=False))
                    props = {"name": rec.get("NAME") or rec.get("name") or "",
                             "note": rec.get("NOTE") or rec.get("note") or "",
                             "request": rec.get("REQUEST") or "note"}
                    feats.append({"type": "Feature", "geometry": sr.shape.__geo_interface__,
                                  "properties": props})
        return {"type": "FeatureCollection", "features": feats}
    raise HandoffError("open a .geojson file or a zipped shapefile (.zip)")
