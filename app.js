const cfg = window.APP_CONFIG || {};
const MAX_SPEED_KMH = 60;
const setStatus = m => document.getElementById('status').textContent = m;

// --- Map setup (OpenStreetMap tiles, no API key) ---
const map = L.map('map').setView([-43.5, 171.5], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let days = [];          // parsed itinerary
let stopMarkers = [];   // current map markers
let routeLines = [];
let poiLayers = {};
let docCampsites = null; // cached static DOC GeoJSON

// --- Category styling ---
const CAT_STYLE = {
  stay:     { color: '#2a7', icon: '🏕️' },
  fuel:     { color: '#c30', icon: '⛽' },
  flight:   { color: '#06c', icon: '✈️' },
  food:     { color: '#e90', icon: '🍴' },
  shop:     { color: '#73c', icon: '🛒' },
  waste:    { color: '#876', icon: '💩' },
  wildlife: { color: '#0a8', icon: '🦭' },
  water:    { color: '#08c', icon: '⛵' },
  walk:     { color: '#4363d8', icon: '🥾' },
  activity: { color: '#4363d8', icon: '📍' }
};
function styleFor(category) { return CAT_STYLE[category] || CAT_STYLE.activity; }

// --- Coordinates: read from a pre-baked static file (data/coords.json) ---
// Geocoding happens OFFLINE via scripts/geocode-itinerary.js, run once per
// itinerary edit on your own machine. The deployed site makes no live
// geocoding calls — this keeps things fast, reliable with patchy signal,
// and respectful of Nominatim's free-tier usage policy (it isn't designed
// for apps to hit it on every page load).
let coordsCache = null;
async function loadCoords() {
  if (coordsCache) return coordsCache;
  try {
    const res = await fetch('data/coords.json');
    coordsCache = res.ok ? await res.json() : {};
  } catch (e) {
    coordsCache = {};
  }
  return coordsCache;
}

// --- Load sheet ---
async function loadSheet() {
  const url = document.getElementById('sheetUrl').value || cfg.DEFAULT_SHEET_CSV;
  if (!url) { setStatus('⚠️ Provide a published Google Sheet CSV URL'); return; }
  if (/\/pubhtml/.test(url)) {
    setStatus('⚠️ That looks like a "pubhtml" link (a webpage), not CSV data. Change "/pubhtml" to "/pub" and add "&output=csv" to the end of the URL.');
    return;
  }
  setStatus('Fetching sheet…');
  let csv;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      setStatus(`❌ Sheet fetch failed (HTTP ${res.status}) — check the URL is published and publicly viewable`);
      return;
    }
    csv = await res.text();
  } catch (e) {
    setStatus('❌ Could not fetch sheet — check the URL and your connection');
    return;
  }
  // Sanity check: a real CSV export starts with plain text/commas; Google's HTML
  // pages (or an unpublished/login-walled sheet) come back as an <!doctype html> page.
  if (/^\s*<(!doctype|html)/i.test(csv)) {
    setStatus('❌ The URL returned a webpage, not CSV data. Make sure the link ends in "&output=csv" and that the sheet is published (not just shared).');
    return;
  }
  days = window.ItineraryParser.parseCsv(csv);
  const totalStops = days.reduce((s, d) => s + d.stops.length, 0);
  if (days.length === 0) {
    setStatus('⚠️ Sheet loaded but no "DAY N" headers were found in column A — check you published the "Full Itinerary" tab specifically.');
    return;
  }
  setStatus(`Parsed ${days.length} days, ${totalStops} stops. Matching coordinates…`);

  const coords = await loadCoords();
  for (const day of days) {
    for (const s of day.stops) {
      if (!s.geocodable) continue;
      const g = coords[s.name];
      if (g) Object.assign(s, g);
    }
  }
  populateDayFilter();
  renderSidebar();
  renderMap();
  const unplaced = days.reduce((s, d) => s + d.stops.filter(x => x.geocodable && !x.lat).length, 0);
  setStatus(`✅ Loaded ${days.length} days` + (unplaced ? ` (${unplaced} new places — run scripts/geocode-itinerary.js and redeploy)` : ''));
}

function populateDayFilter() {
  const sel = document.getElementById('dayFilter');
  sel.innerHTML = '<option value="all">All days</option>'
    + days.map(d => `<option value="${d.dayNum}">Day ${d.dayNum} · ${d.dayTitle}</option>`).join('');
}

function selectedDays() {
  const v = document.getElementById('dayFilter').value;
  return v === 'all' ? days : days.filter(d => d.dayNum === +v);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// --- Sidebar render ---
function renderSidebar() {
  const root = document.getElementById('dayList');
  root.innerHTML = selectedDays().map(d => `
    <div class="day-card">
      <strong>Day ${d.dayNum}</strong> · ${escapeHtml(d.dayTitle)}
      ${d.stops.map(s => `
        <div class="stop-row">
          <span>${styleFor(s.category).icon}</span>
          <span>${escapeHtml(s.name)}</span>
          ${s.durationMin ? `<span class="tag">${s.durationMin}m</span>` : ''}
          ${s.cost && !isNaN(parseFloat(s.cost)) ? `<span class="tag">$${s.cost}</span>` : ''}
          ${s.geocodable && !s.lat ? `<span class="tag warn">no pin</span>` : ''}
        </div>`).join('')}
    </div>`).join('');
}

// --- Map render ---
const DAY_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#bfef45', '#f032e6'];
let renderGeneration = 0; // bumped on every renderMap() call; guards against stale async route draws

function renderMap() {
  stopMarkers.forEach(m => map.removeLayer(m)); stopMarkers = [];
  routeLines.forEach(l => map.removeLayer(l));  routeLines = [];
  const myGeneration = ++renderGeneration;

  const sel = selectedDays();
  const bounds = [];
  const routeJobs = [];

  sel.forEach((day, di) => {
    const color = DAY_COLORS[di % DAY_COLORS.length];
    const pts = day.stops.filter(s => s.lat);
    pts.forEach(s => {
      const style = styleFor(s.category);
      const mk = L.circleMarker([s.lat, s.lng], {
        radius: 7, color: style.color, fillColor: '#fff', fillOpacity: 1, weight: 3
      })
        .bindPopup(`<b>${style.icon} ${escapeHtml(s.name)}</b><br>Day ${day.dayNum}<br>${escapeHtml(s.notes || '')}`)
        .addTo(map);
      stopMarkers.push(mk);
      bounds.push([s.lat, s.lng]);
    });
    if (pts.length > 1) {
      // Draw a straight dashed placeholder immediately (instant, works offline),
      // then queue a request to replace it with the real road-following route.
      const placeholder = L.polyline(pts.map(p => [p.lat, p.lng]),
        { color, weight: 3, opacity: 0.6, dashArray: '6,6' }).addTo(map);
      routeLines.push(placeholder);
      routeJobs.push({ day, pts, color, placeholder });
    }
  });
  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });

  // Sequential queue (≈1 req/sec) so selecting "All days" (up to ~19 legs)
  // doesn't fire a burst of simultaneous requests at OSRM's shared free server.
  runRouteQueue(routeJobs, myGeneration);
}

async function runRouteQueue(jobs, myGeneration) {
  for (const job of jobs) {
    if (myGeneration !== renderGeneration) return; // user changed the day filter — abandon stale queue
    await drawRoadRoute(job.day, job.pts, job.color, job.placeholder, myGeneration);
    if (jobs.length > 1) await new Promise(r => setTimeout(r, 1100));
  }
}

// Fetches the real driving route (following actual roads) for one day's
// stops in order, and swaps it in for the straight dashed placeholder line.
// Falls back to leaving the placeholder in place if OSRM is unreachable.
async function drawRoadRoute(day, pts, color, placeholder, myGeneration) {
  const coords = pts.map(p => `${p.lng},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const j = await res.json();
    const geom = j.routes?.[0]?.geometry;
    if (!geom) return;
    if (myGeneration !== renderGeneration) return; // stale — a newer render has since happened
    map.removeLayer(placeholder);
    const idx = routeLines.indexOf(placeholder);
    if (idx >= 0) routeLines.splice(idx, 1);
    const latlngs = geom.coordinates.map(([lng, lat]) => [lat, lng]);
    const roadLine = L.polyline(latlngs, { color, weight: 4, opacity: 0.85 })
      .bindPopup(`Day ${day.dayNum} route`)
      .addTo(map);
    routeLines.push(roadLine);
  } catch (e) {
    // no signal / OSRM unreachable — keep the straight dashed placeholder
  }
}

// --- OSRM driving-time matrix (free public demo server), with 60 km/h floor ---
// Public OSRM demo server: https://router.project-osrm.org — fine for personal,
// occasional use; not for high-volume or commercial traffic.
async function osrmMatrix(points) {
  const coords = points.map(p => `${p.lng},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=distance,duration`;
  const res = await fetch(url);
  const j = await res.json();
  const n = points.length;
  const distKm = Array.from({ length: n }, () => Array(n).fill(0));
  const durMin = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) if (i !== k) {
    const dKm = (j.distances?.[i]?.[k] || 0) / 1000;
    const tMin = (j.durations?.[i]?.[k] || 0) / 60;
    distKm[i][k] = dKm;
    durMin[i][k] = Math.max(tMin, dKm / MAX_SPEED_KMH * 60);
  }
  return { distKm, durMin };
}

function totalTime(order, mat) {
  let t = 0;
  for (let i = 0; i < order.length - 1; i++) t += mat[order[i]][order[i + 1]];
  return t;
}

function nearestNeighbor(m) {
  const n = m.length, mid = [...Array(n - 2).keys()].map(i => i + 1), order = [0];
  let curr = 0;
  while (mid.length) {
    mid.sort((a, b) => m[curr][a] - m[curr][b]);
    const next = mid.shift(); order.push(next); curr = next;
  }
  order.push(n - 1); return order;
}

function twoOpt(order, m) {
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < order.length - 2; i++) for (let k = i + 1; k < order.length - 1; k++) {
      const d1 = m[order[i - 1]][order[i]] + m[order[k]][order[k + 1]];
      const d2 = m[order[i - 1]][order[k]] + m[order[i]][order[k + 1]];
      if (d2 + 1e-9 < d1) {
        order = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
        improved = true;
      }
    }
  }
  return order;
}

// --- Optimizer / sanity check ---
async function doubleCheck() {
  const report = document.getElementById('optimizeReport');
  report.innerHTML = '';
  setStatus('Checking route order against OSRM (60 km/h floor applied)…');
  for (const day of selectedDays()) {
    const pts = day.stops.filter(s => s.lat);
    if (pts.length < 3) continue;
    let mat;
    try {
      mat = await osrmMatrix(pts);
    } catch (e) {
      report.innerHTML += `<div class="day-card"><strong>Day ${day.dayNum}</strong><div class="warn">⚠️ Routing service unavailable — try again later</div></div>`;
      continue;
    }
    const { durMin, distKm } = mat;
    const planned = pts.map((_, i) => i);
    const optimized = twoOpt(nearestNeighbor(durMin), durMin);
    const tPlan = totalTime(planned, durMin);
    const tOpt = totalTime(optimized, durMin);
    const dPlan = totalTime(planned, distKm);
    const dOpt = totalTime(optimized, distKm);
    const delta = tPlan - tOpt;
    const same = optimized.every((v, i) => v === planned[i]);
    const cls = delta > 5 ? 'delta-bad' : 'delta-good';
    report.innerHTML += `
      <div class="day-card">
        <strong>Day ${day.dayNum}</strong>
        <div>Your order: ${dPlan.toFixed(0)} km · ${(tPlan / 60).toFixed(1)} h drive</div>
        <div>Optimal: ${dOpt.toFixed(0)} km · ${(tOpt / 60).toFixed(1)} h drive</div>
        <div class="${cls}">${same ? '✅ Already optimal' :
        `⚠️ Could save ~${delta.toFixed(0)} min by reordering:<br>${optimized.map(i => escapeHtml(pts[i].name)).join(' → ')}`}</div>
      </div>`;
  }
  setStatus('✅ Route check complete');
}

// --- Static DOC campsite layer (baked-in GeoJSON, works without live signal) ---
async function loadDocCampsites() {
  if (poiLayers.docCampsite) { map.removeLayer(poiLayers.docCampsite); delete poiLayers.docCampsite; return; }
  if (!docCampsites) {
    try {
      const res = await fetch('data/doc-campsites.geojson');
      if (!res.ok) throw new Error('not found');
      docCampsites = await res.json();
    } catch (e) {
      setStatus('⚠️ data/doc-campsites.geojson not found — see README to add DOC campsite data');
      document.querySelector('input[data-layer="docCampsite"]').checked = false;
      return;
    }
  }
  const layer = L.geoJSON(docCampsites, {
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      radius: 6, color: '#2a7', fillColor: '#fff', fillOpacity: 1, weight: 3
    }),
    onEachFeature: (feature, layer) => {
      const p = feature.properties || {};
      const name = p.name || 'DOC Campsite';
      const lines = [`<b>⛺ ${escapeHtml(name)}</b>`];
      if (p.place) lines.push(escapeHtml(p.place));
      const tags = [p.category, p.free === 'Yes' ? 'Free' : null, p.bookable === 'Yes' ? 'Bookable' : null].filter(Boolean);
      if (tags.length) lines.push(escapeHtml(tags.join(' · ')));
      const sites = [];
      if (p.unpoweredSites && +p.unpoweredSites > 0) sites.push(`${p.unpoweredSites} unpowered`);
      if (p.poweredSites && +p.poweredSites > 0) sites.push(`${p.poweredSites} powered`);
      if (sites.length) lines.push(escapeHtml(sites.join(', ') + ' sites'));
      if (p.facilities) lines.push(`<small>${escapeHtml(p.facilities)}</small>`);
      if (p.dogsAllowed) lines.push(`<small>🐕 ${escapeHtml(p.dogsAllowed)}</small>`);
      if (p.url) lines.push(`<a href="${encodeURI(p.url)}" target="_blank" rel="noopener">More info ↗</a>`);
      layer.bindPopup(lines.join('<br>'), { maxWidth: 260 });
    }
  });
  layer.addTo(map);
  poiLayers.docCampsite = layer;
}

// --- Live OSM Overpass layers (campsites/holiday parks/dump/water/fuel) ---
const LAYER_Q = {
  campsite: '["tourism"="camp_site"]', caravan: '["tourism"="caravan_site"]',
  dump: '["amenity"="sanitary_dump_station"]', water: '["amenity"="drinking_water"]', fuel: '["amenity"="fuel"]'
};
const LAYER_STYLE = {
  campsite: { color: '#2a7', icon: '⛺' }, caravan: { color: '#27a', icon: '🏕️' },
  dump: { color: '#a72', icon: '🚽' }, water: { color: '#08c', icon: '💧' }, fuel: { color: '#c30', icon: '⛽' }
};
async function loadLayer(key) {
  if (poiLayers[key]) { map.removeLayer(poiLayers[key]); delete poiLayers[key]; }
  const b = map.getBounds();
  const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  const q = `[out:json][timeout:25];(node${LAYER_Q[key]}(${bbox});way${LAYER_Q[key]}(${bbox}););out center 250;`;
  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: q });
    const j = await r.json();
    const layer = L.layerGroup();
    j.elements.forEach(el => {
      const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
      if (lat == null) return;
      L.circleMarker([lat, lng], { radius: 5, color: LAYER_STYLE[key].color, fillOpacity: 0.7 })
        .bindPopup(`<b>${LAYER_STYLE[key].icon} ${escapeHtml(el.tags?.name || key)}</b><br>${Object.entries(el.tags || {}).slice(0, 6).map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`).join('<br>')}`)
        .addTo(layer);
    });
    layer.addTo(map);
    poiLayers[key] = layer;
  } catch (e) {
    setStatus(`⚠️ Could not load ${key} layer — check your connection`);
    document.querySelector(`input[data-layer="${key}"]`).checked = false;
  }
}

// --- Wiring ---
document.getElementById('loadBtn').onclick = loadSheet;
document.getElementById('optimizeBtn').onclick = doubleCheck;
document.getElementById('dayFilter').onchange = () => { renderSidebar(); renderMap(); };
document.getElementById('sidebarToggle').onclick = () => document.getElementById('sidebar').classList.toggle('open');
document.querySelectorAll('input[data-layer]').forEach(cb => {
  cb.addEventListener('change', () => {
    const key = cb.dataset.layer;
    if (key === 'docCampsite') { loadDocCampsites(); return; }
    if (cb.checked) loadLayer(key);
    else if (poiLayers[key]) { map.removeLayer(poiLayers[key]); delete poiLayers[key]; }
  });
});

// --- Init ---
if (cfg.DEFAULT_SHEET_CSV) document.getElementById('sheetUrl').value = cfg.DEFAULT_SHEET_CSV;
loadDocCampsites(); // load by default since checkbox starts checked
if (cfg.DEFAULT_SHEET_CSV) loadSheet();
else setStatus('Paste your published Google Sheet CSV URL above and click Load');
