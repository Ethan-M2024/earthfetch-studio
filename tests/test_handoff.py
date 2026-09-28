"""Markup exports: every format an analyst might ask for."""

import io
import json
import zipfile

import pytest
import shapefile
from fastapi.testclient import TestClient

from app import handoff, main

FC = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-110.85, 43.49]},
     "properties": {"name": "Bridge abutment", "note": "Erosion here? " * 40,
                    "request": "site", "author": "PM"}},
    {"type": "Feature", "geometry": {"type": "LineString",
                                     "coordinates": [[-110.86, 43.48], [-110.84, 43.50]]},
     "properties": {"name": "Levee", "note": "Check crest height", "request": "analysis"}},
    {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[
        [-110.87, 43.48], [-110.86, 43.48], [-110.86, 43.49], [-110.87, 43.49],
        [-110.87, 43.48]]]},
     "properties": {"name": "Restoration site", "note": "Élan: flood risk?",
                    "request": "question"}},
    {"type": "Feature", "geometry": {"type": "MultiPoint",
                                     "coordinates": [[-110.8, 43.5], [-110.81, 43.51]]},
     "properties": {"name": "Wells"}},
]}


def test_clean_measures_and_explodes():
    feats = handoff.clean_features(FC)
    assert len(feats) == 5                          # MultiPoint split into 2 pins
    area = feats[2]["properties"]
    assert 150 < area["area_acres"] < 250           # ~0.8 km x 1.1 km box
    assert feats[1]["properties"]["length_mi"] > 1
    assert feats[0]["properties"]["request"] == "Needs a site visit"
    with pytest.raises(handoff.HandoffError):
        handoff.clean_features({"type": "FeatureCollection", "features": []})


def test_shapefile_zip_round_trips():
    feats = handoff.clean_features(FC)
    z = zipfile.ZipFile(io.BytesIO(handoff.to_shapefile_zip(feats)))
    names = set(z.namelist())
    for kind in ("points", "lines", "areas"):
        for ext in ("shp", "shx", "dbf", "prj", "cpg"):
            assert f"markups_{kind}.{ext}" in names
    r = shapefile.Reader(shp=io.BytesIO(z.read("markups_areas.shp")),
                         shx=io.BytesIO(z.read("markups_areas.shx")),
                         dbf=io.BytesIO(z.read("markups_areas.dbf")), encoding="utf-8")
    rec = r.record(0).as_dict()
    assert rec["NAME"] == "Restoration site" and rec["NOTE"] == "Élan: flood risk?"
    assert rec["AREA_AC"] > 100
    pts = shapefile.Reader(shp=io.BytesIO(z.read("markups_points.shp")),
                           shx=io.BytesIO(z.read("markups_points.shx")),
                           dbf=io.BytesIO(z.read("markups_points.dbf")), encoding="utf-8")
    assert len(pts) == 3 and len(pts.record(0)["NOTE"]) == 254   # long note truncated


def test_kml_and_csv():
    feats = handoff.clean_features(FC)
    kml = handoff.to_kml(feats, "Snake River").decode()
    assert kml.count("<Placemark>") == 5 and "<Polygon>" in kml and "Snake River" in kml
    rows = handoff.to_csv(feats).decode("utf-8-sig").splitlines()
    assert rows[0].startswith("id,type,name") and len(rows) >= 6
    assert ("Erosion here? " * 40).strip() in rows[1]   # CSV keeps the full note


def test_import_round_trip_via_api():
    c = TestClient(main.app)
    shp = handoff.to_shapefile_zip(handoff.clean_features(FC))
    r = c.post("/api/import", files={"file": ("reply.zip", shp, "application/zip")})
    assert r.status_code == 200, r.text
    assert len(r.json()["features"]) == 5
    g = c.post("/api/import", files={"file": ("a.geojson", json.dumps(FC).encode(),
                                              "application/geo+json")})
    assert len(g.json()["features"]) == 5
    bad = c.post("/api/import", files={"file": ("x.txt", b"hi", "text/plain")})
    assert bad.status_code == 422


def test_export_endpoints_and_handoff_package():
    main._CACHE.clear()
    main._CACHE["abc123"] = {"title": "Floodplain map: Snake River", "product": "rem",
                             "meta": {"river": "Snake River"}, "code":
                             "import earthfetch as ef\n\nr = ef.rem((1, 2, 3, 4))",
                             "_tif": b"II*\x00fake"}
    c = TestClient(main.app)
    body = {"features": FC, "project": {"name": "Wilson Levee Review", "author": "Ethan",
                                        "message": "Please check flood risk."},
            "layers": ["abc123", "expired"]}
    for fmt, head in [("geojson", b"{"), ("shapefile", b"PK"), ("kml", b"<?xml"),
                      ("csv", "﻿".encode())]:
        r = c.post(f"/api/export/{fmt}", json=body)
        assert r.status_code == 200 and r.content.startswith(head), fmt
        assert "wilson_levee_review" in r.headers["content-disposition"]
    r = c.post("/api/handoff", json=body)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    assert {"README.txt", "markups.geojson", "markups.kml", "notes.csv",
            "shapefile/markups_areas.shp", "layers/rem_abc123.tif",
            "reproduce_layers.py"} <= names
    readme = z.read("README.txt").decode()
    assert "Wilson Levee Review" in readme and "Please check flood risk." in readme
    assert "[Needs analysis] Line \"Levee\"" in readme
    assert "ef.rem" in z.read("reproduce_layers.py").decode()
    empty = c.post("/api/handoff", json={"features": {"type": "FeatureCollection",
                                                       "features": []}})
    assert empty.status_code == 422
