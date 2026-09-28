---
title: earthfetch Studio
emoji: 🌎
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: true
license: mit
short_description: Any place on Earth to a finished map, with the Python code
---

# earthfetch Studio

Search any place on Earth, draw a box, and get a finished map in seconds:
floodplain maps (Relative Elevation Models), terrain, cloud-free satellite
imagery, vegetation (NDVI), Sentinel-1 radar, open water, and US aerial
photos. Every map comes with the exact
[earthfetch](https://github.com/Ethan-M2024/earthfetch) Python code that made
it, plus GeoTIFF and PNG downloads. Free data, no account, no API keys.

**Live:** https://huggingface.co/spaces/DataDude26/earthfetch-studio

## How it works

A small FastAPI server calls earthfetch, which reads only your box from
cloud-optimized files (USGS 3DEP and NHD, Copernicus, ESA Sentinel-1/2, USDA
NAIP, PGC ArcticDEM, OpenStreetMap). The result is warped to Web Mercator and
pinned onto a Leaflet map.

## Run locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 7860
# open http://localhost:7860
```

or with Docker:

```bash
docker build -t earthfetch-studio . && docker run -p 7860:7860 earthfetch-studio
```

## Limits

Areas are capped per map type (40 to 400 km²) to keep the free server
responsive. The code under each map runs on your own machine for any size.

Built by [Ethan Muhlestein](https://www.linkedin.com/in/ethan-muhlestein-8a54b5191).
MIT license.
