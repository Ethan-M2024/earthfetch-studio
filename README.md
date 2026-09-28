# earthfetch Studio

A map tool for project managers with no GIS background. Look at a site from
above, mark what you need, and hand it to your GIS or remote sensing analyst
in the formats they use. It runs on your own computer; nothing to sign up for.

## Get started (project managers)

1. **Download** [earthfetch-studio.zip](https://github.com/Ethan-M2024/earthfetch-studio/releases/latest/download/earthfetch-studio.zip)
   and unzip it anywhere, like your Desktop or Documents.
2. **Double-click `Start Studio.bat`** (Windows) or **`Start Studio.command`** (Mac).
   - The first time, it sets itself up. That takes a few minutes and needs
     about 400 MB of space. After that it starts in seconds.
   - Mac: if it says the file is from an unidentified developer, right-click
     it, choose **Open**, then **Open** again. You only do this once.
   - Windows: if a blue "Windows protected your PC" box appears, click
     **More info**, then **Run anyway**.
3. **Your browser opens Studio** at <http://localhost:7860>. If it doesn't,
   copy that address into your browser.
4. **Keep the black window open** while you work. Close it to stop Studio.

Your work is saved in your browser, so you can close Studio and pick up later.

## What you can do

1. **Look.** Find a site and turn on plain-language layers: aerial photo,
   satellite photo, elevation, flood-prone ground (a Relative Elevation
   Model), plant health, and water from radar. Each layer explains what its
   colors mean.
2. **Mark up.** Drop pins, draw lines, and outline areas. Give each one a
   name, a note, and what you need: a note, analysis, better data, a site
   visit, or a question. Areas and lengths are measured for you.
3. **Send.** Download one package for your analyst: markups as Shapefile,
   GeoJSON, and KML, every note in a spreadsheet, the map layers you viewed
   as GeoTIFFs, a README, and the
   [earthfetch](https://github.com/Ethan-M2024/earthfetch) Python code that
   rebuilds each layer. Analysts can send a GeoJSON or zipped shapefile back,
   and you open it in Studio.

Free public data (USGS, ESA Copernicus, USDA, OpenStreetMap); no accounts or
API keys. An internet connection is needed to load maps.

## Troubleshooting

- **Setup didn't finish.** A work VPN or firewall may block the downloads
  (astral.sh and pypi.org). Try off VPN, or ask IT to allow them, then run
  the launcher again.
- **Start over.** Delete the hidden `.tools` and `.venv` folders inside the
  Studio folder and run the launcher again.
- **Port in use.** If another program uses port 7860, close it and retry.

## For analysts and developers

A FastAPI server calls earthfetch for map layers and writes the exports
(pyshp, pyproj); the front end is Leaflet with Leaflet-Geoman for drawing.

```bash
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 7860
pytest
```

A `Dockerfile` is included for hosting it on a server for a whole team.

Exports are WGS84 (EPSG:4326). Shapefile NOTE fields are cut at 254
characters; the GeoJSON and CSV keep the full text. Imported shapefiles must
be in WGS84.

Built by [Ethan Muhlestein](https://www.linkedin.com/in/ethan-muhlestein-8a54b5191). MIT license.
