(() => {
  "use strict";

  const PRODUCTS = [
    { id: "rem", name: "Floodplain", blurb: "Height above the river (REM)", sw: "linear-gradient(90deg,#081d58,#41b6c4,#ffffd9)", badge: "NEW",
      opts: ["river", "resolution", "vmax"] },
    { id: "terrain", name: "Terrain", blurb: "Elevation with hillshade", sw: "linear-gradient(90deg,#333399,#00b6a0,#fdfd96,#805540,#fff)",
      opts: ["resolution"] },
    { id: "satellite", name: "Satellite", blurb: "Cloud-free Sentinel-2", sw: "linear-gradient(90deg,#3d5a3a,#a89b76,#6b8fb3)",
      opts: ["dates"] },
    { id: "ndvi", name: "Vegetation", blurb: "NDVI greenness", sw: "linear-gradient(90deg,#a50026,#fee08b,#006837)",
      opts: ["dates"] },
    { id: "radar", name: "Radar", blurb: "Sentinel-1, sees through cloud", sw: "linear-gradient(90deg,#000,#fff)", badge: "NEW",
      opts: ["dates"] },
    { id: "water", name: "Open water", blurb: "Water mapped from radar", sw: "#1e88e5", badge: "NEW",
      opts: ["dates"] },
    { id: "aerial", name: "Aerial photo", blurb: "NAIP 1 m, US only", sw: "linear-gradient(90deg,#5d6b4a,#b9a88a)",
      opts: [] },
  ];

  const EXAMPLES = [
    { label: "Snake River, Jackson Hole", product: "rem", bbox: [-110.875, 43.475, -110.835, 43.515], options: { river: "Snake", resolution: "1m", vmax: 5 } },
    { label: "Yellowstone at Livingston", product: "rem", bbox: [-110.72, 45.38, -110.62, 45.46], options: { resolution: "1m", vmax: 10 } },
    { label: "Mount Rainier terrain", product: "terrain", bbox: [-121.85, 46.80, -121.70, 46.90], options: { resolution: "10m" } },
    { label: "Great Salt Lake from radar", product: "water", bbox: [-112.35, 41.0, -112.20, 41.10], options: {} },
    { label: "Moab from space", product: "satellite", bbox: [-109.60, 38.54, -109.50, 38.62], options: {} },
    { label: "Sacramento Valley farms", product: "ndvi", bbox: [-121.90, 38.90, -121.75, 39.00], options: {} },
  ];

  const $ = (id) => document.getElementById(id);
  const state = { bbox: null, product: "rem", overlay: null, rect: null, busy: false, maxArea: {} };

  // ------------------------------------------------------------------ map
  const map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([43.5, -110.8], 10);
  const bases = {
    imagery: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" }),
    light: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 16, attribution: "Basemap © Esri, HERE, Garmin, OpenStreetMap contributors" }),
  };
  const labels = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, pane: "shadowPane", opacity: 0.9 });
  bases.imagery.addTo(map);
  labels.addTo(map);

  document.querySelectorAll(".basemaps button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".basemaps button").forEach((x) => x.classList.toggle("on", x === b));
    Object.values(bases).forEach((l) => map.removeLayer(l));
    bases[b.dataset.base].addTo(map).bringToBack();
  }));

  // ------------------------------------------------------------- products
  function renderProducts() {
    const box = $("products");
    box.innerHTML = "";
    PRODUCTS.forEach((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "prod";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(p.id === state.product));
      b.innerHTML = `<b><span class="sw" style="background:${p.sw}"></span>${p.name}${p.badge ? `<span class="new">${p.badge}</span>` : ""}</b><small>${p.blurb}</small>`;
      b.addEventListener("click", () => { state.product = p.id; renderProducts(); renderOpts(); updateArea(); });
      box.appendChild(b);
    });
  }

  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const ago = new Date(today.getTime() - 90 * 864e5);

  function renderOpts(values = {}) {
    const p = PRODUCTS.find((x) => x.id === state.product);
    const box = $("opts");
    box.innerHTML = "";
    const add = (html) => box.insertAdjacentHTML("beforeend", html);
    if (p.opts.includes("river")) {
      add(`<label class="field wide">River name (optional)<input id="o-river" placeholder="Auto: the main river in your box" value="${values.river || ""}"></label>`);
    }
    if (p.opts.includes("resolution")) {
      const r = values.resolution || "10m";
      add(`<label class="field">Elevation data<select id="o-resolution">
        <option value="1m" ${r === "1m" ? "selected" : ""}>1 m lidar (US, best)</option>
        <option value="10m" ${r === "10m" ? "selected" : ""}>10 m (US), 30 m worldwide</option>
        <option value="30m" ${r === "30m" ? "selected" : ""}>30 m (fastest)</option></select></label>`);
    }
    if (p.opts.includes("vmax")) {
      add(`<label class="field">Color scale top (m)<input id="o-vmax" type="number" min="1" max="50" step="1" value="${values.vmax || 6}"></label>`);
      add(`<p class="hint">Draw the box around a valley with the river running through it. A few km of river works best.</p>`);
    }
    if (p.opts.includes("dates")) {
      add(`<label class="field">From<input id="o-start" type="date" value="${values.start || iso(ago)}"></label>`);
      add(`<label class="field">To<input id="o-end" type="date" value="${values.end || iso(today)}"></label>`);
    }
  }

  function readOpts() {
    const o = {};
    const v = (id) => { const el = $(id); return el ? el.value.trim() : ""; };
    if (v("o-river")) o.river = v("o-river");
    if (v("o-resolution")) o.resolution = v("o-resolution");
    if (v("o-vmax")) o.vmax = Number(v("o-vmax"));
    if (v("o-start")) o.start = v("o-start");
    if (v("o-end")) o.end = v("o-end");
    return o;
  }

  // ----------------------------------------------------------------- area
  function areaKm2([w, s, e, n]) {
    const lat = ((s + n) / 2) * Math.PI / 180;
    return Math.abs(e - w) * 111.32 * Math.cos(lat) * Math.abs(n - s) * 110.57;
  }

  function setBbox(bbox, fit = true) {
    state.bbox = bbox.map((x) => Math.round(x * 1e5) / 1e5);
    const [w, s, e, n] = state.bbox;
    if (state.rect) map.removeLayer(state.rect);
    state.rect = L.rectangle([[s, w], [n, e]], { color: "#3fbfa8", weight: 2, fill: false, dashArray: "6 4", interactive: false }).addTo(map);
    if (fit) map.fitBounds([[s, w], [n, e]], { padding: [40, 40] });
    updateArea();
  }

  function updateArea() {
    const el = $("area");
    if (!state.bbox) { $("go").disabled = true; return; }
    const a = areaKm2(state.bbox);
    const limit = state.maxArea[state.product];
    const txt = a < 1 ? `${a.toFixed(2)} km²` : `${a.toFixed(a < 10 ? 1 : 0)} km²`;
    if (limit && a > limit) {
      el.className = "area bad";
      el.textContent = `Area: ${txt}. This map is limited to ${limit} km² here, so draw a smaller box.`;
      $("go").disabled = true;
    } else {
      el.className = "area ok";
      el.textContent = `Area: ${txt}`;
      $("go").disabled = state.busy;
    }
  }

  // drawing a box: pointer drag on the map
  let drawStart = null, drawRect = null;
  function startDraw() {
    document.body.classList.add("drawing");
    $("drawhint").hidden = false;
    $("draw").classList.add("on");
    map.dragging.disable();
    if (window.innerWidth <= 800) document.querySelector(".app").classList.add("map-only");
  }
  function stopDraw() {
    document.body.classList.remove("drawing");
    $("drawhint").hidden = true;
    $("draw").classList.remove("on");
    map.dragging.enable();
    drawStart = null;
    if (drawRect) { map.removeLayer(drawRect); drawRect = null; }
  }
  const mapEl = $("map");
  mapEl.addEventListener("pointerdown", (ev) => {
    if (!document.body.classList.contains("drawing")) return;
    drawStart = map.mouseEventToLatLng(ev);
    mapEl.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  mapEl.addEventListener("pointermove", (ev) => {
    if (!drawStart) return;
    const cur = map.mouseEventToLatLng(ev);
    const b = L.latLngBounds(drawStart, cur);
    if (drawRect) drawRect.setBounds(b);
    else drawRect = L.rectangle(b, { color: "#3fbfa8", weight: 2, fillOpacity: 0.08, interactive: false }).addTo(map);
  });
  mapEl.addEventListener("pointerup", (ev) => {
    if (!drawStart) return;
    const b = L.latLngBounds(drawStart, map.mouseEventToLatLng(ev));
    stopDraw();
    document.querySelector(".app").classList.remove("map-only");
    if (Math.abs(b.getEast() - b.getWest()) < 1e-4 || Math.abs(b.getNorth() - b.getSouth()) < 1e-4) return;
    setBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], false);
  });
  $("draw").addEventListener("click", () => (document.body.classList.contains("drawing") ? stopDraw() : startDraw()));
  $("cancel-draw").addEventListener("click", () => { stopDraw(); document.querySelector(".app").classList.remove("map-only"); });
  $("useview").addEventListener("click", () => {
    const b = map.getBounds();
    setBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], false);
  });

  // search
  $("search").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const q = $("q").value.trim();
    if (q.length < 2) return;
    setStatus(`<span class="spin"></span>Finding ${escapeHtml(q)}…`);
    try {
      const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || "place not found");
      let [w, s, e, n] = j.bbox;
      // shrink huge places (states, countries) and grow points (peaks,
      // towns) to a sensible box around the center
      const limit = state.maxArea[state.product] || 100;
      const a = areaKm2(j.bbox);
      if (a > limit || a < 4) {
        const cx = (w + e) / 2, cy = (s + n) / 2;
        const side = a > limit ? Math.sqrt(limit * 0.6) : 6;
        const dLat = side / 2 / 110.57, dLon = side / 2 / (111.32 * Math.cos(cy * Math.PI / 180));
        [w, s, e, n] = [cx - dLon, cy - dLat, cx + dLon, cy + dLat];
      }
      setBbox([w, s, e, n]);
      setStatus("");
    } catch (err) {
      setStatus(escapeHtml(err.message), true);
    }
  });

  // ---------------------------------------------------------------- render
  function setStatus(html, err = false) {
    const el = $("status");
    el.className = "status" + (err ? " err" : "");
    el.innerHTML = html;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const TIPS = [
    "Reading only your box from cloud-optimized files, never whole scenes.",
    "No API keys: every source here is free and open.",
    "Floodplain maps sample the river every 20 m and model the water surface.",
    "Radar works at night and through storms.",
  ];

  async function go() {
    if (!state.bbox || state.busy) return;
    state.busy = true;
    $("go").disabled = true;
    const t0 = performance.now();
    let tip = 0;
    const tick = () => {
      const s = ((performance.now() - t0) / 1000).toFixed(0);
      setStatus(`<span class="spin"></span>Building your map… ${s}s<br><small>${TIPS[tip % TIPS.length]}</small>`);
    };
    tick();
    const timer = setInterval(() => { tick(); if (Math.round((performance.now() - t0) / 1000) % 6 === 0) tip++; }, 1000);
    try {
      const r = await fetch("/api/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: state.product, bbox: state.bbox, options: readOpts() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || `server error (${r.status})`);
      show(j);
      setStatus("");
    } catch (err) {
      setStatus(escapeHtml(err.message), true);
    } finally {
      clearInterval(timer);
      state.busy = false;
      updateArea();
    }
  }
  $("go").addEventListener("click", go);

  function show(j) {
    if (state.overlay) map.removeLayer(state.overlay);
    state.overlay = L.imageOverlay(j.image, j.bounds, { opacity: $("opacity").value / 100, interactive: false }).addTo(map);
    labels.bringToFront();
    map.fitBounds(j.bounds, { padding: [30, 30] });

    $("result").hidden = false;
    $("r-title").textContent = j.title;
    $("r-time").textContent = `${j.seconds}s · ${j.area_km2} km²`;
    const labelsFor = { river: "River", centerline: "Centerline", dem: "Elevation data", source: "Source", pixel_m: "Pixel size",
      dates: "Dates", date: "Date", passes: "Radar passes", mean: "Mean NDVI", min_m: "Lowest", max_m: "Highest", water_pct: "Water" };
    const fmt = (k, v) => k === "pixel_m" ? `${v} m` : (k === "min_m" || k === "max_m") ? `${v} m` : k === "water_pct" ? `${v}%` :
      k === "centerline" ? ({ nhd: "USGS NHD", osm: "OpenStreetMap", user: "your line" }[v] || v) : v;
    $("r-meta").innerHTML = Object.entries(j.meta || {}).map(([k, v]) =>
      `<dt>${labelsFor[k] || k}</dt><dd>${escapeHtml(fmt(k, v))}</dd>`).join("");
    $("r-code").textContent = j.code;
    $("dl-tif").href = `/api/download/${j.id}.tif`;
    $("dl-png").href = `/api/download/${j.id}.png`;

    const lg = $("legend");
    if (j.legend) {
      const L2 = j.legend;
      if (L2.kind === "swatch") {
        lg.innerHTML = `<div class="swatch"><i style="background:${L2.colors[0]}"></i>${escapeHtml(L2.label)}</div>`;
      } else {
        const mid = (L2.vmin + L2.vmax) / 2;
        const f = (x) => Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10;
        lg.innerHTML = `<div class="lt">${escapeHtml(L2.label)}</div>
          <div class="bar" style="background:linear-gradient(90deg,${L2.colors.join(",")})"></div>
          <div class="ticks"><span>${f(L2.vmin)}</span><span>${f(mid)}</span><span>${f(L2.vmax)}${/above river/.test(L2.label) ? "+" : ""}</span></div>`;
      }
      lg.hidden = false;
    } else {
      lg.hidden = true;
    }
    if (window.innerWidth <= 800) $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("opacity").addEventListener("input", (ev) => { if (state.overlay) state.overlay.setOpacity(ev.target.value / 100); });
  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("r-code").textContent);
      $("copy").textContent = "Copied";
    } catch { $("copy").textContent = "Select and copy"; }
    setTimeout(() => ($("copy").textContent = "Copy"), 1500);
  });
  $("panel-toggle").addEventListener("click", () => document.querySelector(".app").classList.toggle("map-only"));

  // examples
  EXAMPLES.forEach((ex) => {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "chip";
    c.textContent = ex.label;
    c.addEventListener("click", () => {
      state.product = ex.product;
      renderProducts();
      renderOpts(ex.options);
      setBbox(ex.bbox);
      go();
    });
    $("examples").appendChild(c);
  });

  // boot
  renderProducts();
  renderOpts();
  fetch("/api/products").then((r) => r.json()).then((j) => { state.maxArea = j.max_area_km2 || {}; updateArea(); }).catch(() => {});
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("bbox")) {
    const b = hash.get("bbox").split(",").map(Number);
    if (b.length === 4 && b.every(Number.isFinite)) {
      if (hash.get("product")) state.product = hash.get("product");
      renderProducts(); renderOpts();
      setBbox(b);
    }
  }
})();
