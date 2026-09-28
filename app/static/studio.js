(() => {
  "use strict";

  // ------------------------------------------------------------ catalog
  // Plain-language layers. `ends` label the two sides of the legend.
  const LAYERS = [
    { id: "aerial", name: "Aerial photo", blurb: "Sharp photo of buildings, roads and trees. US only.",
      sw: "linear-gradient(135deg,#4f5d3a,#9c8f6b,#6d7f59)", opts: [],
      explain: "A USDA aerial photo with about 1 m detail, usually 1 to 3 years old. Good for seeing what is on the ground." },
    { id: "satellite", name: "Satellite photo", blurb: "A recent cloud-free view, anywhere on Earth.",
      sw: "linear-gradient(135deg,#3d5a3a,#a89b76,#6b8fb3)", opts: ["dates"],
      explain: "Stitched from recent Sentinel-2 satellite passes with clouds removed. Each pixel is 10 m, about the size of a house." },
    { id: "terrain", name: "Elevation", blurb: "Hills and valleys, colored by height.",
      sw: "linear-gradient(135deg,#333399,#00b6a0,#fdfd96,#805540,#fff)", opts: ["detail"], ends: ["Low", "High"],
      explain: "Blue is low ground and white is high ground. The shading shows slopes, as if lit from the northwest." },
    { id: "rem", name: "Flood-prone ground", blurb: "How high the land sits above the nearby river.",
      sw: "linear-gradient(135deg,#081d58,#41b6c4,#ffffd9)", opts: ["river", "detail", "vmax"], ends: ["River level", "Higher ground"],
      explain: "Dark blue ground sits at or near river level and floods first. Light yellow is higher and drier. Numbers are meters above the river." },
    { id: "ndvi", name: "Plant health", blurb: "Where vegetation is thriving, sparse, or bare.",
      sw: "linear-gradient(135deg,#a50026,#fee08b,#006837)", opts: ["dates"], ends: ["Bare", "Lush"],
      explain: "Green is healthy, growing vegetation. Yellow is sparse or dry. Red is bare soil, pavement, rock, or water." },
    { id: "water", name: "Water", blurb: "Open water, seen by radar even through clouds.",
      sw: "#1e88e5", opts: ["dates"],
      explain: "Blue marks open water detected by satellite radar, which works through clouds and at night. Useful for flood extents." },
  ];
  const MORE = [
    { id: "radar", name: "Radar", blurb: "Raw radar brightness, day or night, any weather.",
      sw: "linear-gradient(135deg,#000,#888,#fff)", opts: ["dates"], ends: ["Smooth (water)", "Rough (built)"],
      explain: "Bright areas are rough or built surfaces. Dark areas are smooth, like calm water or pavement." },
  ];
  const ALL = [...LAYERS, ...MORE];
  const byId = (id) => ALL.find((l) => l.id === id);

  const EXAMPLES = [
    { label: "Snake River floodplain, WY", product: "rem", bbox: [-110.875, 43.475, -110.835, 43.515], options: { river: "Snake", resolution: "1m", vmax: 5 } },
    { label: "Yellowstone River, MT", product: "rem", bbox: [-110.72, 45.38, -110.62, 45.46], options: { resolution: "1m", vmax: 10 } },
    { label: "Mount Rainier elevation", product: "terrain", bbox: [-121.85, 46.80, -121.70, 46.90], options: { resolution: "10m" } },
    { label: "Moab from space", product: "satellite", bbox: [-109.60, 38.54, -109.50, 38.62], options: {} },
  ];

  const REQUESTS = {
    note: { label: "Just a note", color: "#64748b" },
    analysis: { label: "Needs analysis", color: "#0f7b6c" },
    data: { label: "Needs better data", color: "#7c3aed" },
    site: { label: "Needs a site visit", color: "#ea580c" },
    question: { label: "Question", color: "#2563eb" },
  };

  const $ = (id) => document.getElementById(id);
  const STORE = "efstudio:v1";
  const state = { product: "aerial", layers: [], maxArea: {}, busy: false, selected: null, reshaping: null };

  // ------------------------------------------------------------------ map
  const map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([39.5, -98.5], 4);
  const esri = (path, attribution, maxZoom = 19) =>
    L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`, { maxZoom, attribution });
  const bases = {
    imagery: esri("World_Imagery", "Imagery © Esri, Maxar, Earthstar Geographics"),
    streets: esri("World_Street_Map", "© Esri, HERE, Garmin, OpenStreetMap contributors"),
    topo: esri("World_Topo_Map", "© Esri, HERE, Garmin, USGS, OpenStreetMap contributors"),
  };
  const labels = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, pane: "shadowPane", opacity: 0.9 });
  let base = "imagery";
  bases.imagery.addTo(map);
  labels.addTo(map);

  document.querySelectorAll(".basemaps button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".basemaps button").forEach((x) => x.classList.toggle("on", x === b));
    map.removeLayer(bases[base]);
    base = b.dataset.base;
    bases[base].addTo(map).bringToBack();
    if (base === "imagery") labels.addTo(map); else map.removeLayer(labels);
  }));

  // ------------------------------------------------------------------ tabs
  const TABS = ["look", "mark", "send"];
  function showTab(name) {
    TABS.forEach((t) => {
      $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
      $(`pane-${t}`).hidden = t !== name;
    });
    if (name !== "mark") stopTool();
    if (name === "send") renderSummary();
  }
  TABS.forEach((t) => $(`tab-${t}`).addEventListener("click", () => showTab(t)));

  // ------------------------------------------------------------- picker
  function renderPicker() {
    const card = (l) => `<button type="button" class="pick" role="radio" data-id="${l.id}" aria-checked="${l.id === state.product}">
        <span class="sw" style="background:${l.sw}"></span><span><b>${l.name}</b><small>${l.blurb}</small></span></button>`;
    $("picker").innerHTML = LAYERS.map(card).join("");
    $("picker-more").innerHTML = MORE.map(card).join("");
    document.querySelectorAll(".pick").forEach((b) => b.addEventListener("click", () => {
      state.product = b.dataset.id;
      renderPicker();
      renderOpts();
    }));
  }

  const iso = (d) => d.toISOString().slice(0, 10);
  function renderOpts(values = {}) {
    const l = byId(state.product);
    const box = $("opts");
    const parts = [];
    if (l.opts.includes("river")) {
      parts.push(`<label class="field wide">River name (leave blank to use the main river)<input id="o-river" placeholder="e.g. Snake" value="${escapeHtml(values.river || "")}"></label>`);
    }
    if (l.opts.includes("detail")) {
      const r = values.resolution || (l.id === "rem" ? "1m" : "10m");
      parts.push(`<label class="field">Detail<select id="o-resolution">
        <option value="1m" ${r === "1m" ? "selected" : ""}>Best (1 m lidar, US)</option>
        <option value="10m" ${r === "10m" ? "selected" : ""}>Standard</option>
        <option value="30m" ${r === "30m" ? "selected" : ""}>Fastest</option></select></label>`);
    }
    if (l.opts.includes("vmax")) {
      parts.push(`<label class="field">Top of color scale (m above river)<input id="o-vmax" type="number" min="1" max="50" step="1" value="${values.vmax || 6}"></label>`);
      parts.push(`<p class="hint">Works best with a river running through the middle of your view.</p>`);
    }
    if (l.opts.includes("dates")) {
      const today = new Date();
      parts.push(`<label class="field">From<input id="o-start" type="date" value="${values.start || iso(new Date(today - 90 * 864e5))}"></label>`);
      parts.push(`<label class="field">To<input id="o-end" type="date" value="${values.end || iso(today)}"></label>`);
    }
    box.innerHTML = parts.join("");
    $("opts-box").hidden = parts.length === 0;
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

  // ----------------------------------------------------------- geometry
  const rad = (d) => d * Math.PI / 180;
  function areaKm2([w, s, e, n]) {
    return Math.abs(e - w) * 111.32 * Math.cos(rad((s + n) / 2)) * Math.abs(n - s) * 110.57;
  }
  function ringAreaM2(latlngs) {   // spherical excess approximation
    const R = 6378137;
    let a = 0;
    for (let i = 0; i < latlngs.length; i++) {
      const p1 = latlngs[i], p2 = latlngs[(i + 1) % latlngs.length];
      a += rad(p2.lng - p1.lng) * (2 + Math.sin(rad(p1.lat)) + Math.sin(rad(p2.lat)));
    }
    return Math.abs(a * R * R / 2);
  }
  function lineLenM(latlngs) {
    let d = 0;
    for (let i = 1; i < latlngs.length; i++) d += map.distance(latlngs[i - 1], latlngs[i]);
    return d;
  }
  function sizeText(layer) {
    if (layer instanceof L.Marker) {
      const p = layer.getLatLng();
      return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    }
    if (layer instanceof L.Polygon) {
      const m2 = ringAreaM2(layer.getLatLngs()[0]);
      const ac = m2 / 4046.86;
      return ac >= 640 ? `${(ac / 640).toFixed(2)} sq mi` : `${ac < 10 ? ac.toFixed(2) : ac.toFixed(1)} acres`;
    }
    const m = lineLenM(layer.getLatLngs());
    return m < 160 ? `${Math.round(m * 3.28084)} ft` : `${(m / 1609.344).toFixed(2)} mi`;
  }

  // the view to map: whatever is on screen, trimmed to the layer's limit
  function viewBbox(product) {
    const b = map.getBounds();
    let w = Math.max(b.getWest(), -180), e = Math.min(b.getEast(), 180);
    let s = Math.max(b.getSouth(), -85), n = Math.min(b.getNorth(), 85);
    const a = areaKm2([w, s, e, n]);
    const lim = (state.maxArea[product] || 100) * 0.95;
    let trimmed = false;
    if (a > lim) {
      const k = Math.sqrt(lim / a);
      const cx = (w + e) / 2, cy = (s + n) / 2;
      const hw = (e - w) * k / 2, hh = (n - s) * k / 2;
      [w, s, e, n] = [cx - hw, cy - hh, cx + hw, cy + hh];
      trimmed = true;
    }
    return { bbox: [w, s, e, n].map((x) => Math.round(x * 1e5) / 1e5), trimmed, viewArea: a };
  }

  // --------------------------------------------------------------- search
  $("search").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const q = $("q").value.trim();
    if (q.length < 2) return;
    setStatus("status", `<span class="spin"></span>Finding ${escapeHtml(q)}…`);
    try {
      const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || "place not found");
      let [w, s, e, n] = j.bbox;
      if (areaKm2(j.bbox) < 4) {   // a point (a peak, an address): show ~3 km around it
        const cx = (w + e) / 2, cy = (s + n) / 2, d = 0.0135;
        [w, s, e, n] = [cx - d / Math.cos(rad(cy)), cy - d, cx + d / Math.cos(rad(cy)), cy + d];
      }
      map.fitBounds([[s, w], [n, e]]);
      setStatus("status", `Found ${escapeHtml(j.name.split(",").slice(0, 3).join(","))}.`, "ok");
    } catch (err) {
      setStatus("status", `Couldn't find that. Try adding a state or country. (${escapeHtml(err.message)})`, "err");
    }
  });

  // ---------------------------------------------------------------- render
  function setStatus(id, html, kind = "") {
    const el = $(id);
    el.className = "status" + (kind ? " " + kind : "");
    el.innerHTML = html;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function renderLayer(product, bbox, options, trimmed = false) {
    if (state.busy) return;
    state.busy = true;
    $("go").disabled = true;
    const l = byId(product);
    const t0 = performance.now();
    const tick = () => setStatus("status",
      `<span class="spin"></span>Making "${l.name}"… ${Math.round((performance.now() - t0) / 1000)}s`);
    tick();
    const timer = setInterval(tick, 1000);
    try {
      const r = await fetch("/api/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, bbox, options }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || `the server had a problem (${r.status})`);
      addLayer(product, j);
      setStatus("status", trimmed
        ? `Done. Your view was large, so the center ${j.area_km2} km² was mapped. Zoom in to map a different spot.`
        : `Done in ${j.seconds}s.`, "ok");
    } catch (err) {
      setStatus("status", escapeHtml(err.message), "err");
    } finally {
      clearInterval(timer);
      state.busy = false;
      $("go").disabled = false;
    }
  }

  $("go").addEventListener("click", () => {
    const { bbox, trimmed, viewArea } = viewBbox(state.product);
    if (viewArea > 250000) {
      setStatus("status", "Zoom in to your site first. The map is showing too much of the world.", "err");
      return;
    }
    renderLayer(state.product, bbox, readOpts(), trimmed);
  });

  // share of the smaller box covered by the other one
  function overlap(a, b) {
    const [[s1, w1], [n1, e1]] = a, [[s2, w2], [n2, e2]] = b;
    const w = Math.max(0, Math.min(e1, e2) - Math.max(w1, w2));
    const h = Math.max(0, Math.min(n1, n2) - Math.max(s1, s2));
    const small = Math.min((e1 - w1) * (n1 - s1), (e2 - w2) * (n2 - s2));
    return small > 0 ? (w * h) / small : 0;
  }

  function addLayer(product, j) {
    const existing = state.layers.find((x) => x.key === j.id);
    if (existing) {
      existing.overlay.bringToFront();
      existing.visible = true;
      existing.overlay.setOpacity(existing.opacity);
    } else {
      // remapping the same layer over mostly the same ground replaces it
      const same = state.layers.find((x) => x.product === product && overlap(x.bounds, j.bounds) > 0.6);
      if (same) {
        map.removeLayer(same.overlay);
        state.layers.splice(state.layers.indexOf(same), 1);
      }
      const n = state.layers.filter((x) => x.product === product).length;
      const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const overlay = L.imageOverlay(j.image, j.bounds, { opacity: 1, interactive: false }).addTo(map);
      state.layers.unshift({ key: j.id, product, title: byId(product).name, bounds: j.bounds,
        detail: j.title + (n ? ` ${n + 1}` : ""), stamp: `${j.area_km2} km² · ${time}`, overlay,
        visible: true, opacity: 1, legend: j.legend, meta: j.meta, code: j.code });
    }
    labels.bringToFront();
    map.fitBounds(j.bounds, { padding: [30, 30] });
    renderLayerList();
    renderLegend();
    renderCode();
  }

  const META_LABELS = { river: "River", centerline: "River line", dem: "Elevation data", source: "Elevation data",
    pixel_m: "Detail", dates: "Dates", date: "Date", passes: "Radar passes", mean: "Average",
    min_m: "Lowest", max_m: "Highest", water_pct: "Water" };
  const metaText = (k, v) => k === "pixel_m" ? `${v} m pixels` : (k === "min_m" || k === "max_m") ? `${v} m` :
    k === "water_pct" ? `${v}% of the area` : k === "centerline" ? ({ nhd: "USGS", osm: "OpenStreetMap", user: "yours" }[v] || v) : v;

  function renderLayerList() {
    $("layers-block").hidden = state.layers.length === 0;
    $("layer-list").innerHTML = state.layers.map((lay, i) => {
      const meta = Object.entries(lay.meta || {}).filter(([k]) => META_LABELS[k])
        .map(([k, v]) => `${META_LABELS[k]}: ${escapeHtml(metaText(k, v))}`).join(" · ");
      return `<li class="lay" data-i="${i}">
        <div class="lay-h"><input type="checkbox" ${lay.visible ? "checked" : ""} aria-label="Show ${lay.title}">
          <b>${escapeHtml(lay.detail || lay.title)}</b><button class="x" type="button" aria-label="Remove">×</button></div>
        <p>${escapeHtml(byId(lay.product).explain)}</p>
        <div class="lay-meta">${escapeHtml(lay.stamp || "")}${meta ? " · " + meta : ""}</div>
        <input type="range" min="0" max="100" value="${Math.round(lay.opacity * 100)}" aria-label="See-through">
      </li>`;
    }).join("");
    document.querySelectorAll(".lay").forEach((li) => {
      const lay = state.layers[Number(li.dataset.i)];
      li.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
        lay.visible = e.target.checked;
        lay.overlay.setOpacity(lay.visible ? lay.opacity : 0);
        renderLegend();
      });
      li.querySelector("input[type=range]").addEventListener("input", (e) => {
        lay.opacity = e.target.value / 100;
        if (lay.visible) lay.overlay.setOpacity(lay.opacity);
      });
      li.querySelector(".x").addEventListener("click", () => {
        map.removeLayer(lay.overlay);
        state.layers.splice(state.layers.indexOf(lay), 1);
        renderLayerList(); renderLegend(); renderCode();
      });
    });
  }

  function renderLegend() {
    const lay = state.layers.find((x) => x.visible && x.legend);
    const el = $("legend");
    if (!lay) { el.hidden = true; return; }
    const lg = lay.legend, cat = byId(lay.product);
    if (lg.kind === "swatch") {
      el.innerHTML = `<div class="lt">${escapeHtml(cat.name)}</div><div class="swatch"><i style="background:${lg.colors[0]}"></i>${escapeHtml(lg.label)}</div>`;
    } else {
      const f = (x) => Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10;
      const top = lay.product === "rem" ? "+" : "";
      el.innerHTML = `<div class="lt">${escapeHtml(lg.label)}</div>
        <div class="bar" style="background:linear-gradient(90deg,${lg.colors.join(",")})"></div>
        <div class="ticks"><span>${f(lg.vmin)}</span><span>${f((lg.vmin + lg.vmax) / 2)}</span><span>${f(lg.vmax)}${top}</span></div>
        ${cat.ends ? `<div class="ends"><span>${cat.ends[0]}</span><span>${cat.ends[1]}</span></div>` : ""}`;
    }
    el.hidden = false;
  }

  function renderCode() {
    $("code").textContent = state.layers.length
      ? "import earthfetch as ef\n\n" + state.layers.slice().reverse()
        .map((l) => `# ${l.detail || l.title}\n` + l.code.replace("import earthfetch as ef\n\n", "")).join("\n\n")
      : "Show a layer on the map first.";
  }

  $("copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("code").textContent); $("copy").textContent = "Copied"; }
    catch { $("copy").textContent = "Select and copy"; }
    setTimeout(() => ($("copy").textContent = "Copy"), 1500);
  });

  EXAMPLES.forEach((ex) => {
    const c = document.createElement("button");
    c.type = "button"; c.className = "chip"; c.textContent = ex.label;
    c.addEventListener("click", () => {
      state.product = ex.product;
      renderPicker(); renderOpts(ex.options);
      const [w, s, e, n] = ex.bbox;
      map.fitBounds([[s, w], [n, e]]);
      renderLayer(ex.product, ex.bbox, ex.options);
    });
    $("examples").appendChild(c);
  });

  // ---------------------------------------------------------------- markup
  const marks = L.featureGroup().addTo(map);
  let nextId = 1;

  const pinIcon = (request) => L.divIcon({
    className: "pin", iconSize: [28, 36], iconAnchor: [14, 34], tooltipAnchor: [0, -30],
    html: `<svg viewBox="0 0 28 36" width="28" height="36"><path d="M14 35S2 23.5 2 13a12 12 0 0 1 24 0c0 10.5-12 22-12 22Z" fill="${REQUESTS[request].color}" stroke="#fff" stroke-width="2"/><circle cx="14" cy="13" r="4.5" fill="#fff"/></svg>`,
  });
  const styleFor = (request) => ({ color: REQUESTS[request].color, weight: 3, fillOpacity: 0.18, opacity: 1 });

  map.pm.setGlobalOptions({
    continueDrawing: false, snappable: true,
    markerStyle: { icon: pinIcon("note") },
    pathOptions: styleFor("note"),
    templineStyle: { color: "#0f7b6c", dashArray: "6 4" },
    hintlineStyle: { color: "#0f7b6c", dashArray: "6 4" },
  });

  const TOOL_HINTS = {
    Marker: "Click where you want the pin.",
    Line: "Click to add points. Click the last point again to finish.",
    Polygon: "Click each corner. Click the first point to close the area.",
  };
  let activeTool = null;
  function startTool(tool) {
    stopTool();
    finishReshape();
    activeTool = tool;
    document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
    $("drawhint-text").textContent = TOOL_HINTS[tool];
    $("drawhint").hidden = false;
    map.pm.enableDraw(tool);
    if (window.innerWidth <= 800) document.querySelector(".app").classList.add("map-only");
  }
  function stopTool() {
    if (activeTool) map.pm.disableDraw();
    activeTool = null;
    document.querySelectorAll(".tool").forEach((b) => b.classList.remove("on"));
    $("drawhint").hidden = true;
  }
  document.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () =>
    activeTool === b.dataset.tool ? stopTool() : startTool(b.dataset.tool)));
  $("cancel-draw").addEventListener("click", () => { stopTool(); document.querySelector(".app").classList.remove("map-only"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { stopTool(); finishReshape(); } });

  const kindOf = (layer) => layer instanceof L.Marker ? "Pin" : layer instanceof L.Polygon ? "Area" : "Line";
  function requestKey(value) {
    if (REQUESTS[value]) return value;
    const k = Object.entries(REQUESTS).find(([, v]) => v.label === value);
    return k ? k[0] : "note";
  }

  function adopt(layer, props = {}) {
    layer.props = {
      id: props.id || `m${Date.now().toString(36)}${nextId++}`,
      name: props.name || "",
      note: props.note || "",
      request: requestKey(props.request),
      created: props.created || new Date().toISOString().slice(0, 16).replace("T", " "),
    };
    restyle(layer);
    layer.on("click", () => select(layer));
    layer.on("pm:edit pm:dragend", () => {
      save(); renderMarks();
      if (state.selected === layer) $("ed-size").textContent = sizeText(layer);
    });
    marks.addLayer(layer);
    return layer;
  }
  function restyle(layer) {
    const r = layer.props.request;
    if (layer instanceof L.Marker) layer.setIcon(pinIcon(r)); else layer.setStyle(styleFor(r));
    layer.unbindTooltip();
    layer.bindTooltip(escapeHtml(layer.props.name || kindOf(layer)), { className: "mk-tip", direction: "top" });
  }

  map.on("pm:create", (e) => {
    const layer = e.layer;
    map.removeLayer(layer);
    stopTool();
    document.querySelector(".app").classList.remove("map-only");
    adopt(layer);
    save();
    select(layer);
    $("ed-name").focus();
  });

  function select(layer) {
    finishReshape();
    state.selected = layer;
    showTab("mark");
    const p = layer.props;
    $("editor").hidden = false;
    $("ed-kind").textContent = kindOf(layer);
    $("ed-size").textContent = sizeText(layer);
    $("ed-name").value = p.name;
    $("ed-request").value = p.request;
    $("ed-note").value = p.note;
    $("ed-reshape").textContent = layer instanceof L.Marker ? "Move" : "Reshape";
    renderMarks();
  }
  function deselect() {
    finishReshape();
    state.selected = null;
    $("editor").hidden = true;
    renderMarks();
  }

  $("editor").addEventListener("submit", (e) => {
    e.preventDefault();
    const layer = state.selected;
    if (!layer) return;
    layer.props.name = $("ed-name").value.trim();
    layer.props.request = $("ed-request").value;
    layer.props.note = $("ed-note").value.trim();
    restyle(layer);
    save();
    deselect();
  });
  // live color change so the PM sees what each category looks like
  $("ed-request").addEventListener("change", () => {
    if (!state.selected) return;
    state.selected.props.request = $("ed-request").value;
    restyle(state.selected);
  });
  $("ed-delete").addEventListener("click", () => {
    if (!state.selected) return;
    finishReshape();
    marks.removeLayer(state.selected);
    state.selected = null;
    $("editor").hidden = true;
    save(); renderMarks();
  });
  $("ed-reshape").addEventListener("click", () => {
    const layer = state.selected;
    if (!layer) return;
    if (state.reshaping) { finishReshape(); return; }
    state.reshaping = layer;
    layer.pm.enable({ allowSelfIntersection: false, draggable: true });
    $("ed-reshape").textContent = "Done";
  });
  function finishReshape() {
    if (!state.reshaping) return;
    state.reshaping.pm.disable();
    state.reshaping = null;
    if (state.selected) $("ed-reshape").textContent = state.selected instanceof L.Marker ? "Move" : "Reshape";
    save(); renderMarks();
  }

  const ICONS = {
    Pin: `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" fill="currentColor"/></svg>`,
    Area: `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 7 12 4l7 5-2 9H7Z" fill="currentColor"/></svg>`,
    Line: `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 18 10 9l4 5 6-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`,
  };
  function renderMarks() {
    const layers = marks.getLayers();
    $("mark-empty").hidden = layers.length > 0;
    $("mark-count").hidden = layers.length === 0;
    $("mark-count").textContent = layers.length;
    $("mark-list").innerHTML = layers.map((layer) => {
      const p = layer.props, r = REQUESTS[p.request];
      return `<li class="mk${layer === state.selected ? " sel" : ""}" data-id="${p.id}">
        <span class="ico" style="background:${r.color}">${ICONS[kindOf(layer)]}</span>
        <span><b>${escapeHtml(p.name || kindOf(layer))}</b><small>${r.label}${p.note ? " · " + escapeHtml(p.note) : ""}</small></span>
        <span class="size">${sizeText(layer)}</span></li>`;
    }).join("");
    document.querySelectorAll(".mk").forEach((li) => li.addEventListener("click", () => {
      const layer = marks.getLayers().find((l) => l.props.id === li.dataset.id);
      if (!layer) return;
      if (layer instanceof L.Marker) map.setView(layer.getLatLng(), Math.max(map.getZoom(), 15));
      else map.fitBounds(layer.getBounds(), { padding: [60, 60], maxZoom: 17 });
      select(layer);
    }));
  }

  function toGeoJSON() {
    const author = $("author").value.trim();
    return {
      type: "FeatureCollection",
      features: marks.getLayers().map((layer) => {
        const f = layer.toGeoJSON(6);
        f.properties = { ...layer.props, author };
        return f;
      }),
    };
  }

  function loadGeoJSON(fc, fit = true) {
    let n = 0;
    L.geoJSON(fc, {
      pointToLayer: (_f, latlng) => L.marker(latlng),
      onEachFeature: (f, layer) => { adopt(layer, f.properties || {}); n++; },
    });
    renderMarks();
    if (fit && n) map.fitBounds(marks.getBounds(), { padding: [40, 40], maxZoom: 16 });
    return n;
  }

  $("import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch("/api/import", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || "couldn't read that file");
      const n = loadGeoJSON(j);
      save();
      note(`Opened ${n} markup${n === 1 ? "" : "s"} from ${file.name}.`);
    } catch (err) {
      note(err.message, true);
    }
  });
  function note(msg, err = false) {
    const el = $("mark-empty");
    el.hidden = false;
    el.textContent = msg;
    el.style.color = err ? "var(--warn)" : "var(--accent)";
    setTimeout(() => {
      el.style.color = "";
      el.textContent = "Nothing marked yet. Drop a pin on anything you have a question about.";
      renderMarks();
    }, 4000);
  }

  // two-step clear, no browser dialogs
  let clearArmed = null;
  $("clear").addEventListener("click", () => {
    if (!marks.getLayers().length) return;
    if (!clearArmed) {
      $("clear").textContent = "Click again to delete all";
      clearArmed = setTimeout(() => { clearArmed = null; $("clear").textContent = "Clear all"; }, 3000);
      return;
    }
    clearTimeout(clearArmed); clearArmed = null;
    $("clear").textContent = "Clear all";
    finishReshape();
    marks.clearLayers();
    deselect(); save();
  });

  // ------------------------------------------------------------------- send
  function projectInfo() {
    return { name: $("project").value.trim(), author: $("author").value.trim(), message: $("message").value.trim() };
  }
  function renderSummary() {
    const all = marks.getLayers();
    const c = { Pin: 0, Line: 0, Area: 0 };
    all.forEach((l) => c[kindOf(l)]++);
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    $("send-summary").textContent = all.length
      ? `${plural(c.Pin, "pin")}, ${plural(c.Line, "line")}, ${plural(c.Area, "area")}` +
        (state.layers.length ? `, plus ${plural(state.layers.length, "map layer")} you viewed.` : ".")
      : "Nothing to send yet. Mark something in step 2 first.";
    $("package").disabled = all.length === 0;
    document.querySelectorAll(".fmt").forEach((b) => (b.disabled = all.length === 0));
  }

  async function download(url, body, what) {
    setStatus("send-status", `<span class="spin"></span>Preparing ${what}…`);
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail || `the server had a problem (${r.status})`);
      }
      const name = (r.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || "markups";
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      setStatus("send-status", `Downloaded ${escapeHtml(name)}.`, "ok");
    } catch (err) {
      setStatus("send-status", escapeHtml(err.message), "err");
    }
  }
  $("package").addEventListener("click", () => download("/api/handoff",
    { features: toGeoJSON(), project: projectInfo(), layers: state.layers.map((l) => l.key) }, "your package"));
  document.querySelectorAll(".fmt").forEach((b) => b.addEventListener("click", () =>
    download(`/api/export/${b.dataset.fmt}`, { features: toGeoJSON(), project: projectInfo() },
      b.querySelector("b").textContent)));

  // ---------------------------------------------------------------- storage
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const c = map.getCenter();
        localStorage.setItem(STORE, JSON.stringify({
          ...projectInfo(), features: toGeoJSON(), view: [c.lat, c.lng, map.getZoom()] }));
        $("saved").textContent = "Saved in this browser";
      } catch { $("saved").textContent = "Not saved (browser storage is off)"; }
    }, 300);
  }
  ["project", "author", "message"].forEach((id) => $(id).addEventListener("input", save));
  map.on("moveend", save);

  function restore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || "null");
      if (!s) return false;
      $("project").value = s.name || "";
      $("author").value = s.author || "";
      $("message").value = s.message || "";
      if (s.features) loadGeoJSON(s.features, false);
      if (s.view) map.setView([s.view[0], s.view[1]], s.view[2]);
      return true;
    } catch { return false; }
  }

  // ------------------------------------------------------------------- boot
  const app = document.querySelector(".app");
  const syncToggle = () => ($("panel-toggle").textContent = app.classList.contains("map-only") ? "Show panel" : "Full map");
  new MutationObserver(syncToggle).observe(app, { attributes: true, attributeFilter: ["class"] });
  $("panel-toggle").addEventListener("click", () => app.classList.toggle("map-only"));
  syncToggle();

  renderPicker();
  renderOpts();
  renderMarks();
  fetch("/api/products").then((r) => r.json()).then((j) => { state.maxArea = j.max_area_km2 || {}; }).catch(() => {});
  if (!restore()) map.setView([43.495, -110.855], 13);
})();
