"""API tests with earthfetch mocked out: no network."""

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import main, render
from app.render import Legend, Result, StudioError


@pytest.fixture(autouse=True)
def clear_cache():
    main._CACHE.clear()


def _fake(product, bbox, opts):
    xr = pytest.importorskip("xarray")
    h, w = 30, 40
    data = np.linspace(0, 5, h * w, dtype="float32").reshape(h, w)
    tf = (10.0, 0.0, 500000.0, 0.0, -10.0, 4800000.0)
    da = xr.DataArray(data, dims=("y", "x"), name="rem",
                      attrs={"crs": "EPSG:32612", "transform": tf})
    rgba = np.full((4, h, w), 200, dtype="uint8")
    return Result(rgba, tf, "EPSG:32612", da, "r = ef.rem(...)", "Floodplain map",
                  Legend("Height above river (m)", 0, 5, ["#000", "#fff"]),
                  meta={"river": "Snake River", "pixel_m": 10})


def test_health_and_products():
    c = TestClient(main.app)
    assert c.get("/api/health").json()["ok"]
    j = c.get("/api/products").json()
    assert "rem" in j["products"] and j["max_area_km2"]["rem"] > 0


def test_render_returns_pinned_image_code_and_downloads(monkeypatch):
    monkeypatch.setattr(main, "render", _fake)
    c = TestClient(main.app)
    body = {"product": "rem", "bbox": [-110.9, 43.47, -110.83, 43.52], "options": {}}
    r = c.post("/api/render", json=body)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["image"] == f"/api/image/{j['id']}.webp"
    assert c.get(j["image"]).content[:4] == b"RIFF"
    (s, w), (n, e) = j["bounds"]
    assert s < n and w < e
    assert j["code"].startswith("import earthfetch as ef")
    assert j["legend"]["label"] == "Height above river (m)"
    tif = c.get(f"/api/download/{j['id']}.tif")
    assert tif.status_code == 200 and tif.content[:2] in (b"II", b"MM")
    png = c.get(f"/api/download/{j['id']}.png")
    assert png.content[:8] == b"\x89PNG\r\n\x1a\n"
    # second call is served from the cache
    calls = []
    monkeypatch.setattr(main, "render", lambda *a: calls.append(a))
    assert c.post("/api/render", json=body).json()["id"] == j["id"] and not calls


def test_render_errors_are_readable(monkeypatch):
    def boom(*a):
        raise StudioError("no clear scenes found")

    monkeypatch.setattr(main, "render", boom)
    r = TestClient(main.app).post("/api/render", json={"product": "satellite",
                                                       "bbox": [0, 0, 0.1, 0.1]})
    assert r.status_code == 422 and "no clear scenes" in r.json()["detail"]


def test_area_limit_and_validation():
    with pytest.raises(StudioError, match="limited to"):
        render.render("aerial", [-112, 40, -111, 41], {})
    with pytest.raises(StudioError, match="draw a box"):
        render.render("rem", [1, 1, 1, 1], {})
    with pytest.raises(StudioError, match="unknown product"):
        render.render("lidar", [0, 0, 0.01, 0.01], {})


def test_expired_download():
    assert TestClient(main.app).get("/api/download/nope.tif").status_code == 404


def test_res_scales_with_box():
    assert render._res_for((-111, 40, -110.99, 40.01), 10) == 10
    big = render._res_for((-111, 40, -110.8, 40.2), 1)
    assert big > 10       # a 17 km box at 1 m would be 17k px; capped at 1400
