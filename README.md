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

A map tool for project managers with no GIS background. Look at a site from
above, mark what you need, and hand it to your GIS or remote sensing analyst
in the formats they use.

1. **Look.** Find a site and turn on plain-language layers: aerial photo,
   satellite photo, elevation, flood-prone ground (a Relative Elevation
   Model), plant health, and water from radar. Each layer explains what its
   colors mean.
2. **Mark up.** Drop pins, draw lines, and outline areas. Give each one a
   name, a note, and what you need: a note, analysis, better data, a site
   visit, or a question. Areas and lengths are measured for you, and your
   work saves in the browser.
3. **Send.** Download one package for your analyst: markups as Shapefile,
   GeoJSON, and KML, every note in a spreadsheet, the map layers you viewed
   as GeoTIFFs, a README, and the
   [earthfetch](https://github.com/Ethan-M2024/earthfetch) Python code that
   rebuilds each layer. Analysts can send a GeoJSON or zipped shapefile back,
   and the PM opens it in Studio.

Free data, no account, no API keys.

**Live:** https://huggingface.co/spaces/DataDude26/earthfetch-studio

## How it works

A small FastAPI server calls earthfetch for map layers and writes the exports (pyshp, pyproj), which reads only your box from
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
