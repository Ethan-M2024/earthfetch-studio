"""Work on company networks, and say plainly when a network is in the way.

Two things commonly break map downloads inside companies:

* **TLS inspection.** The firewall re-signs HTTPS traffic with the company's
  own certificate, which Windows trusts but Python does not. We make Python
  (requests) use the Windows certificate store via ``truststore``, and hand
  GDAL (the raster reader) a bundle that includes those certificates.
* **A required proxy.** Windows knows it (Internet Options); Python's requests
  reads it too, but GDAL only reads environment variables, so we copy it
  there.

``check()`` then tests every service Studio uses, so a PM can hand IT an exact
list of what to allow.
"""

from __future__ import annotations

import logging
import os
import ssl
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

log = logging.getLogger("studio")

#: every outside service Studio talks to, grouped the way a PM thinks of them
SERVICES = [
    ("Background maps", "server.arcgisonline.com",
     "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=json"),
    ("Place search", "nominatim.openstreetmap.org",
     "https://nominatim.openstreetmap.org/status"),
    ("Place search (backup)", "geocode.arcgis.com",
     "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer?f=json"),
    ("Elevation (US)", "tnmaccess.nationalmap.gov",
     "https://tnmaccess.nationalmap.gov/api/v1/datasets"),
    ("Elevation files (US)", "prd-tnm.s3.amazonaws.com",
     "https://prd-tnm.s3.amazonaws.com/"),
    ("Elevation (worldwide)", "copernicus-dem-30m.s3.amazonaws.com",
     "https://copernicus-dem-30m.s3.amazonaws.com/"),
    ("Rivers (US)", "hydro.nationalmap.gov",
     "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer?f=json"),
    ("Rivers (worldwide)", "overpass-api.de", "https://overpass-api.de/api/status"),
    ("Satellite search", "earth-search.aws.element84.com",
     "https://earth-search.aws.element84.com/v1"),
    ("Satellite images", "sentinel-cogs.s3.us-west-2.amazonaws.com",
     "https://sentinel-cogs.s3.us-west-2.amazonaws.com/"),
    ("Aerial photos and radar", "planetarycomputer.microsoft.com",
     "https://planetarycomputer.microsoft.com/api/stac/v1"),
    ("Aerial photo files", "naipeuwest.blob.core.windows.net",
     "https://naipeuwest.blob.core.windows.net/"),
    ("Radar files", "sentinel1euwestrtc.blob.core.windows.net",
     "https://sentinel1euwestrtc.blob.core.windows.net/"),
]


def _windows_ca_pem() -> str | None:
    """The machine's trusted root certificates (including a company's
    inspection certificate) as one PEM file, combined with certifi's."""
    try:
        ctx = ssl.create_default_context()
        ctx.load_default_certs()
        ders = ctx.get_ca_certs(binary_form=True)
    except Exception:
        return None
    if not ders:
        return None
    parts = []
    try:
        import certifi

        parts.append(Path(certifi.where()).read_text())
    except Exception:
        pass
    parts += [ssl.DER_cert_to_PEM_cert(d) for d in ders]
    path = Path(tempfile.gettempdir()) / "earthfetch-studio-ca.pem"
    path.write_text("\n".join(parts))
    return str(path)


def configure() -> None:
    """Adopt the operating system's certificates and proxy settings."""
    try:
        import truststore

        truststore.inject_into_ssl()
    except Exception as exc:  # not installed, or an old Python
        log.debug("truststore unavailable: %s", exc)
    if os.name == "nt" and not os.environ.get("GDAL_CURL_CA_BUNDLE"):
        pem = _windows_ca_pem()
        if pem:
            os.environ["GDAL_CURL_CA_BUNDLE"] = pem
            os.environ.setdefault("CURL_CA_BUNDLE", pem)
    proxies = urllib.request.getproxies()   # env vars, or the Windows registry
    for scheme in ("http", "https"):
        if proxies.get(scheme):
            os.environ.setdefault(f"{scheme.upper()}_PROXY", proxies[scheme])
            os.environ.setdefault(f"{scheme}_proxy", proxies[scheme])
    if proxies.get("https") or proxies.get("http"):
        os.environ.setdefault("GDAL_HTTP_PROXY", (proxies.get("https") or proxies["http"])
                              .split("://")[-1])
        log.info("using the system proxy for downloads")


def _probe(item):
    label, host, url = item
    from earthfetch.utils import get_session

    t0 = time.time()
    try:
        r = get_session().get(url, timeout=8, stream=True)
        r.close()
        ok = r.status_code < 500   # 403/404 still proves the host is reachable
        err = "" if ok else f"HTTP {r.status_code}"
    except Exception as exc:
        ok, err = False, _plain(exc)
    return {"label": label, "host": host, "ok": ok, "error": err,
            "ms": int((time.time() - t0) * 1000)}


def _plain(exc: Exception) -> str:
    text = str(exc)
    if "CERTIFICATE_VERIFY_FAILED" in text or "SSLError" in type(exc).__name__:
        return "blocked by a security certificate check"
    if "ProxyError" in type(exc).__name__:
        return "the network proxy refused it"
    if "timed out" in text.lower() or "Timeout" in type(exc).__name__:
        return "timed out (likely blocked)"
    if "NameResolution" in text or "getaddrinfo" in text:
        return "address not found (blocked or offline)"
    return "couldn't connect"


def check() -> list[dict]:
    with ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(_probe, SERVICES))
