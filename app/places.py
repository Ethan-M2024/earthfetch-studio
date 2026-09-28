"""Find a place: coordinates, OpenStreetMap Nominatim, or Esri's geocoder.

Several matches come back so the PM can pick the right Springfield. Esri is
the fallback because company networks that block OpenStreetMap usually still
allow ArcGIS services.
"""

from __future__ import annotations

import re

from earthfetch.utils import get_session

NOMINATIM = "https://nominatim.openstreetmap.org/search"
ESRI = ("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/"
        "findAddressCandidates")

_COORDS = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$")


class PlaceError(Exception):
    pass


def _box(lat: float, lon: float, d: float = 0.0135):
    """A ~3 km box around a point, for results that are a single spot."""
    import math

    dl = d / max(0.2, math.cos(math.radians(lat)))
    return [lon - dl, lat - d, lon + dl, lat + d]


def from_coords(q: str):
    m = _COORDS.match(q)
    if not m:
        return None
    a, b = float(m.group(1)), float(m.group(2))
    # "lat, lon" is how people copy coordinates; accept "lon, lat" when only
    # that reading is valid
    lat, lon = (a, b) if abs(a) <= 90 and abs(b) <= 180 else (b, a)
    if abs(lat) > 90 or abs(lon) > 180:
        return None
    return [{"name": f"{lat:.5f}, {lon:.5f}", "detail": "Coordinates",
             "lat": lat, "lon": lon, "bbox": _box(lat, lon)}]


def _nominatim(q: str, limit: int):
    r = get_session().get(NOMINATIM, params={"q": q, "format": "json", "limit": limit,
                                             "addressdetails": 1}, timeout=12)
    r.raise_for_status()
    out = []
    for hit in r.json():
        s, n, w, e = (float(v) for v in hit["boundingbox"])
        parts = [p.strip() for p in hit.get("display_name", "").split(",")]
        out.append({"name": parts[0], "detail": ", ".join(parts[1:4]),
                    "lat": float(hit["lat"]), "lon": float(hit["lon"]),
                    "bbox": [w, s, e, n]})
    return out


def _esri(q: str, limit: int):
    r = get_session().get(ESRI, params={"SingleLine": q, "f": "json", "maxLocations": limit,
                                        "outFields": "Match_addr,Region,Country"}, timeout=12)
    r.raise_for_status()
    out = []
    for c in r.json().get("candidates", []):
        loc, ext = c.get("location") or {}, c.get("extent") or {}
        lat, lon = loc.get("y"), loc.get("x")
        if lat is None:
            continue
        bbox = ([ext["xmin"], ext["ymin"], ext["xmax"], ext["ymax"]]
                if {"xmin", "ymin", "xmax", "ymax"} <= set(ext) else _box(lat, lon))
        parts = [p.strip() for p in c.get("address", "").split(",")]
        out.append({"name": parts[0], "detail": ", ".join(parts[1:4]),
                    "lat": lat, "lon": lon, "bbox": bbox})
    return out


def search(q: str, limit: int = 5) -> list[dict]:
    q = q.strip()
    coords = from_coords(q)
    if coords:
        return coords
    errors = []
    for finder in (_nominatim, _esri):
        try:
            hits = finder(q, limit)
            if hits:
                return hits
        except Exception as exc:  # blocked, offline, rate-limited: try the next
            errors.append(f"{finder.__name__.strip('_')}: {type(exc).__name__}")
    if errors and len(errors) == 2:
        raise PlaceError("the place-search services couldn't be reached from this "
                         "network. Try pasting coordinates (like 43.48, -110.76), or "
                         "run the network check below.")
    raise PlaceError("no match. Try adding a state or country, or paste coordinates.")
