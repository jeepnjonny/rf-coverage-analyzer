/* =========================================================
   RF Path Coverage Analyzer — Frontend
   ========================================================= */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Generate a receiver color by index, spread evenly across H=45°–315°
// (avoiding the red zone H=315°..45°) scaled to the current receiver count.
function rxColor(idx) {
  const total = Math.max(state.receivers?.length ?? 1, 1);
  const h = 45 + (idx % total) * (270 / total);
  return `hsl(${h.toFixed(1)},75%,50%)`;
}

// Same hue formula as rxColor(), converted to hex -- the print-map PNG is
// rendered server-side by Pillow, which doesn't take CSS hsl() strings.
function _hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}
function rxColorHex(idx) {
  const total = Math.max(state.receivers?.length ?? 1, 1);
  return _hslToHex(45 + (idx % total) * (270 / total), 75, 50);
}

const CSV_COLS    = ['name','longitude','latitude','height_agl_m','antenna_gain_dbi','tx_power_dbm','enabled','role'];

const ROLE_LABEL  = { wide1: 'WIDE1 fill-in', wide2: 'WIDE2 backbone', igate: 'iGate', meshtastic: 'Meshtastic Router' };
const TX_POWER_OPTIONS = [
  [20, '20 dBm'], [22, '22 dBm'], [28, '28 dBm'],
  [30, '30 dBm (1W)'], [33, '33 dBm (2W)'], [37, '37 dBm (5W)'], [40, '40 dBm (10W)'],
];
function _snapPower(dbm) {
  const v = parseFloat(dbm) || 28;
  return TX_POWER_OPTIONS.reduce((best, [opt]) =>
    Math.abs(opt - v) < Math.abs(best - v) ? opt : best, TX_POWER_OPTIONS[0][0]);
}
const COORD_DP    = 6;   // decimal places — matches server _rc()

function rc(v) { return parseFloat(v.toFixed(COORD_DP)); }

// Escape user-supplied strings (receiver names, KML placemark/track names,
// saved-analysis names) before interpolating into innerHTML/bindTooltip —
// those values round-trip through uploaded files or free-text inputs and
// are never HTML-safe by construction.
const _ESC_HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => _ESC_HTML_MAP[ch]);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const map = L.map('map', { zoomControl: true, maxZoom: 22 }).setView([39.5, -98.35], 4);

const TILE_LAYERS = {
  'usgs-topo': L.tileLayer(
    'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'USGS Topo', maxZoom: 22, maxNativeZoom: 16 }
  ),
  'usgs-sat': L.tileLayer(
    'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'USGS Imagery', maxZoom: 22, maxNativeZoom: 16 }
  ),
  'osm': L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 22, maxNativeZoom: 19 }
  ),
};
TILE_LAYERS['usgs-topo'].addTo(map);

document.getElementById('basemap-select').addEventListener('change', e => {
  Object.values(TILE_LAYERS).forEach(l => map.removeLayer(l));
  TILE_LAYERS[e.target.value].addTo(map);
});

const pathLayer    = L.layerGroup().addTo(map);
const rxLayer      = L.layerGroup().addTo(map);
const resultLayer  = L.layerGroup().addTo(map);
const interRxLayer = L.layerGroup().addTo(map);

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const state = {
  kmlFile:             null,
  csvFile:             null,
  kmlCoords:           [],
  receivers:           [],
  analysisRunning:     false,
  analysisMode:        null,  // "track" | "links" | null
  pathResults:         [],    // per-point results from last analysis
  interRxResults:      [],    // inter-receiver link results from last analysis
  lastFreqMhz:         915,
  abortController:     null,
  rfStartTime:         null,  // when first points_batch received (for time-remaining estimate)
  currentPathPoint:    null,  // last path point whose profile is shown
  currentProfileRxIdx: -1,   // receiver index currently shown in path-point profile
  currentProfileRx1Idx: -1,  // rx1 index when an inter-receiver profile is open (-1 = none)
  currentProfileRx2Idx: -1,  // rx2 index when an inter-receiver profile is open (-1 = none)
  // Captured at analysis completion for save feature
  lastAnalysisStats:    null,
  lastAnalysisTotalPct: null,
  lastAnalysisParams:   null,
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function coverageColor(pct) {
  // 0–75 %: red → yellow,  75–100 %: yellow → green
  if (pct <= 75) {
    const h = (pct / 75) * 45;
    return `hsl(${h.toFixed(1)}, 78%, 50%)`;
  }
  const h = 45 + ((pct - 75) / 25) * 88;
  return `hsl(${h.toFixed(1)}, 62%, 44%)`;
}

function dbmToWatts(dbm)  { return Math.pow(10, (dbm - 30) / 10); }
function dbmToUV(dbm, z=50) {
  return Math.sqrt(Math.pow(10, dbm / 10) * 1e-3 * z) * 1e6;
}

function fmtPower(dbm) {
  const w = dbmToWatts(dbm);
  if (w >= 1)    return `≈ ${w.toFixed(2)} W`;
  if (w >= 1e-3) return `≈ ${(w*1e3).toFixed(1)} mW`;
  return `≈ ${(w*1e6).toFixed(1)} µW`;
}
function fmtUV(dbm) { return `≈ ${dbmToUV(dbm).toFixed(3)} µV`; }

function setStatus(msg) { document.getElementById('status-text').textContent = msg; }

function showTransferSpinner(msg) {
  document.getElementById('transfer-spinner').classList.remove('hidden');
  if (msg !== undefined) setStatus(msg);
}
function hideTransferSpinner() {
  document.getElementById('transfer-spinner').classList.add('hidden');
}

function setProgress(label, pct) {
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-bar').style.width = `${Math.min(100, pct)}%`;
}

function showProgress(show) {
  document.getElementById('progress-container').classList.toggle('hidden', !show);
}

// ---------------------------------------------------------------------------
// Live RF parameter display
// ---------------------------------------------------------------------------

document.getElementById('tx-power').addEventListener('input', e =>
  document.getElementById('tx-power-w').textContent = fmtPower(+e.target.value || 0));
document.getElementById('rx-sens').addEventListener('input', e =>
  document.getElementById('rx-sens-uv').textContent = fmtUV(+e.target.value || -135));

document.getElementById('tx-power-w').textContent = fmtPower(22);
document.getElementById('rx-sens-uv').textContent = fmtUV(-135);

// ---------------------------------------------------------------------------
// Tab switching (bottom bar)
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('print-summary-btn').addEventListener('click', printDeploymentSummary);

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${name}`));

  // Redraw canvas when profile tab becomes visible
  if (name === 'profile' && state.currentProfileData) {
    drawProfile(state.currentProfileData, document.getElementById('profile-canvas'));
  }
  if (name === 'hardware') renderHardwareTab();
}

// ---------------------------------------------------------------------------
// Cursor info bar
// ---------------------------------------------------------------------------

let _elevTimer       = null;
let _signalHideTimer = null;
const _elevMemo = {};   // simple memo: "lat,lon" -> elevation_m

// Browsers fire mousemove far more often than paint (especially with a high
// polling-rate mouse), and onCursorMove does real work (nearest-point scans +
// several DOM writes) — rAF-gate it so at most one update runs per frame.
let _cursorMoveRaf     = null;
let _pendingCursorLatLng = null;
map.on('mousemove', e => {
  _pendingCursorLatLng = e.latlng;
  if (_cursorMoveRaf !== null) return;
  _cursorMoveRaf = requestAnimationFrame(() => {
    _cursorMoveRaf = null;
    onCursorMove(rc(_pendingCursorLatLng.lat), rc(_pendingCursorLatLng.lng));
  });
});
map.on('mouseout', () => {
  if (_cursorMoveRaf !== null) { cancelAnimationFrame(_cursorMoveRaf); _cursorMoveRaf = null; }
  document.getElementById('info-gps').textContent         = '—';
  document.getElementById('info-elev').textContent        = '—';
  document.getElementById('info-signal').textContent      = '—';
  document.getElementById('info-signal').style.color      = '';
  document.getElementById('info-heat-signal').textContent = '—';
  document.getElementById('info-heat-signal').style.color = '';
  // Delay hiding the signal panel so cursor can slide onto it without it vanishing
  _signalHideTimer = setTimeout(() => {
    document.getElementById('map-signal-panel').classList.add('hidden');
  }, 300);
});

// Keep panel visible while hovering it directly
document.getElementById('map-signal-panel').addEventListener('mouseenter', () => {
  clearTimeout(_signalHideTimer);
});
document.getElementById('map-signal-panel').addEventListener('mouseleave', () => {
  _signalHideTimer = setTimeout(() => {
    document.getElementById('map-signal-panel').classList.add('hidden');
  }, 300);
});

function onCursorMove(lat, lon) {
  clearTimeout(_signalHideTimer);
  document.getElementById('info-gps').textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

  // --- Signal from nearest analysed path point ---
  const nr    = findNearestResult(lat, lon);
  const sigEl = document.getElementById('info-signal');
  if (nr) {
    if (nr.coverage) {
      const name  = state.receivers[nr.best_rx_idx]?.name || `RX${nr.best_rx_idx + 1}`;
      sigEl.textContent = `${nr.best_rssi} dBm (${name})`;
      sigEl.style.color = rxColor(nr.best_rx_idx);
    } else {
      sigEl.textContent = nr.hard_fail ? 'No signal · blocked' : 'No signal · faded';
      sigEl.style.color = nr.hard_fail ? 'var(--danger)' : 'var(--text-dim)';
    }
    _updateSignalPanel(nr);
  } else {
    sigEl.textContent = '—';
    sigEl.style.color = '';
    document.getElementById('map-signal-panel').classList.add('hidden');
  }

  // --- Predicted signal from nearest heat map cell (shown alongside the
  // track signal above, not instead of it, so both are visible when both
  // a track analysis and a heat map are active) ---
  const hc     = findNearestHeatCell(lat, lon);
  const heatEl = document.getElementById('info-heat-signal');
  if (hc) {
    if (hc.coverage) {
      // best_rx_idx indexes into the list the map was scored against, which for
      // a single-site map is one clicked site — not state.receivers.
      const name = state.heatMapReceivers[hc.best_rx_idx]?.name || `RX${hc.best_rx_idx + 1}`;
      heatEl.textContent = `${hc.best_rssi} dBm (${name})`;
      heatEl.style.color = rxColor(hc.best_rx_idx);
    } else {
      heatEl.textContent = hc.hard_fail ? 'No signal · blocked' : 'No signal · faded';
      heatEl.style.color = hc.hard_fail ? 'var(--danger)' : 'var(--text-dim)';
    }
  } else {
    heatEl.textContent = '—';
    heatEl.style.color = '';
  }

  // --- Elevation (debounced) ---
  const key = `${lat},${lon}`;
  if (_elevMemo[key] !== undefined) {
    document.getElementById('info-elev').textContent = `${_elevMemo[key]} m`;
    return;
  }
  document.getElementById('info-elev').textContent = '…';
  clearTimeout(_elevTimer);
  _elevTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/elevation?lat=${lat}&lon=${lon}`);
      const d = await r.json();
      if (d.elevation_m !== undefined) {
        _elevMemo[key] = d.elevation_m;
        document.getElementById('info-elev').textContent = `${d.elevation_m} m`;
      }
    } catch { document.getElementById('info-elev').textContent = '—'; }
  }, 200);
}

function _updateSignalPanel(nr) {
  const panel = document.getElementById('map-signal-panel');
  if (!nr || !nr.rx_results || !nr.rx_results.length) {
    panel.classList.add('hidden');
    return;
  }

  const panelTitle = nr.coverage  ? 'Receivers'
                   : nr.hard_fail ? 'No signal · blocked'
                   :                'No signal · faded';
  const titleColor = nr.coverage  ? ''
                   : nr.hard_fail ? 'color:var(--danger)'
                   :                'color:var(--text-dim)';
  let html = `<div class="signal-panel-title" style="${titleColor}">${panelTitle}</div>`;

  // Build rows for each rx_results entry (server now includes rx_idx per entry)
  for (const rr of nr.rx_results) {
    const rxIdx = rr.rx_idx ?? -1;
    const rx    = rxIdx >= 0 ? state.receivers[rxIdx] : null;
    const name  = escapeHtml(rx?.name || (rxIdx >= 0 ? `RX${rxIdx + 1}` : 'RX?'));
    const color = rxIdx >= 0 ? rxColor(rxIdx) : '#888';

    const sensitivity = parseFloat(document.getElementById('rx-sens').value) || -135;
    const fadeMargin  = parseFloat(document.getElementById('fade-margin').value) || 0;
    const threshold   = sensitivity + fadeMargin;
    const covered     = !rr.hard_fail && rr.rssi >= threshold;
    const rssiColor   = covered ? color : 'var(--text-dim)';

    html += `<div class="signal-rx-row" data-rx-idx="${rxIdx}" data-pt-idx="${nr.idx}">
      <span class="signal-rx-dot" style="background:${color}"></span>
      <span class="signal-rx-name">${name}</span>
      <span class="signal-rx-val" style="color:${rssiColor}">${rr.rssi} dBm</span>
    </div>`;
  }

  panel.innerHTML = html;
  panel.classList.remove('hidden');

  // Wire up click → showPathPointProfile for specific receiver
  panel.querySelectorAll('.signal-rx-row').forEach(row => {
    row.addEventListener('click', () => {
      const ptIdx = parseInt(row.dataset.ptIdx, 10);
      const rxIdx = parseInt(row.dataset.rxIdx, 10);
      const pt = state.pathResults[ptIdx];
      if (pt) showPathPointProfile(pt, rxIdx);
    });
  });
}

// Spatial hash grid for nearest-point lookups, keyed off array identity/length
// so it's only rebuilt when the underlying array actually changes (both
// pathResults and heatMapResults are always either reassigned to [] or grown
// via push(), never mutated in place — see call sites of each). Cell size
// (0.01°) is comfortably larger than either caller's search cutoff, so a
// plain 3×3-neighborhood scan around the query cell is guaranteed to find
// the true nearest point without falling back to a full linear scan.
const _GRID_CELL_DEG = 0.01;
function _gridCellKey(lat, lon) {
  return `${Math.floor(lat / _GRID_CELL_DEG)},${Math.floor(lon / _GRID_CELL_DEG)}`;
}
function _buildSpatialGrid(points) {
  const grid = new Map();
  for (const p of points) {
    const key = _gridCellKey(p.lat, p.lon);
    let cell = grid.get(key);
    if (!cell) { cell = []; grid.set(key, cell); }
    cell.push(p);
  }
  return grid;
}
function _nearestViaGrid(points, cache, lat, lon) {
  if (cache.ref !== points || cache.len !== points.length) {
    cache.ref  = points;
    cache.len  = points.length;
    cache.grid = _buildSpatialGrid(points);
  }
  const cx = Math.floor(lat / _GRID_CELL_DEG);
  const cy = Math.floor(lon / _GRID_CELL_DEG);
  let best = null, bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cell = cache.grid.get(`${cx + dx},${cy + dy}`);
      if (!cell) continue;
      for (const p of cell) {
        const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
        if (d < bestD) { bestD = d; best = p; }
      }
    }
  }
  return { best, bestD };
}

const _pathResultGridCache = { ref: null, len: -1, grid: null };
function findNearestResult(lat, lon) {
  if (!state.pathResults.length) return null;
  const { best, bestD } = _nearestViaGrid(state.pathResults, _pathResultGridCache, lat, lon);
  // Only show if cursor is within ~500 m (≈ 0.005°)
  return bestD < 2.5e-5 ? best : null;
}

const _heatCellGridCache = { ref: null, len: -1, grid: null };
function findNearestHeatCell(lat, lon) {
  if (!state.heatMapResults.length) return null;
  const { best, bestD } = _nearestViaGrid(state.heatMapResults, _heatCellGridCache, lat, lon);
  // Cutoff scales with the grid spacing (roughly one cell's footprint) rather
  // than a fixed distance -- heat map spacing ranges from 25 m to 400 m across
  // resolution tiers, unlike the ~fixed spacing of interpolated track points.
  const spacingM  = state.heatMapSpacingM || 200;
  const degThresh = (spacingM * 0.75) / 111_320;
  return bestD < degThresh ** 2 ? best : null;
}

// ---------------------------------------------------------------------------
// File manager — state
// ---------------------------------------------------------------------------

const fm = {
  tab:           'kml',
  kmlFiles:      [],
  csvFiles:      [],
  analyses:      [],    // saved analysis metadata list
  selKml:        null,
  selCsv:        null,
  selAnalysis:   null,  // selected saved analysis id
  selKmlTrack:   null,  // which LineString is selected for "Load into Map"
  kmlPlacemarks: [],    // point placemarks parsed from current KML
  editorRows:    [],
  editorFile:    null,
};

// ---------------------------------------------------------------------------
// File manager — open / close / tab
// ---------------------------------------------------------------------------

function openFileManager(tab) {
  fm.tab = tab || 'kml';
  document.getElementById('file-mgr-modal').classList.remove('hidden');
  switchFmTab(fm.tab);
  refreshFmFileLists();
}

function closeFmModal() {
  document.getElementById('file-mgr-modal').classList.add('hidden');
}

function switchFmTab(tab) {
  fm.tab = tab;
  document.querySelectorAll('.fm-tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.fmTab === tab));
  document.querySelectorAll('.fm-pane').forEach(p =>
    p.classList.toggle('active', p.id === `fm-pane-${tab}`));
}

// ---------------------------------------------------------------------------
// File manager — file lists
// ---------------------------------------------------------------------------

async function refreshFmFileLists() {
  const [filesRes, analysesRes] = await Promise.all([
    fetch('/api/files'),
    fetch('/api/analyses'),
  ]);
  const filesData = await filesRes.json();
  fm.kmlFiles  = filesData.kml || [];
  fm.csvFiles  = filesData.csv || [];
  fm.analyses  = await analysesRes.json();
  renderFmFileList('kml');
  renderFmFileList('csv');
  renderFmSavedList();
}

function renderFmFileList(type) {
  const el    = document.getElementById(`fm-${type}-list`);
  const files = type === 'kml' ? fm.kmlFiles : fm.csvFiles;
  el.innerHTML = '';
  if (!files.length) {
    el.innerHTML = `<div class="fm-empty">No ${type.toUpperCase()} files</div>`;
    return;
  }
  files.forEach(name => {
    const div       = document.createElement('div');
    div.className   = 'fm-file-item';
    if (name === (type === 'kml' ? fm.selKml : fm.selCsv)) div.classList.add('selected');
    div.textContent = name;
    div.title       = name;
    div.addEventListener('click', () => selectFmFile(type, name));
    el.appendChild(div);
  });
}

async function selectFmFile(type, name) {
  if (type === 'kml') {
    fm.selKml = name;
    renderFmFileList('kml');
    document.getElementById('fm-kml-load-btn').disabled     = false;
    document.getElementById('fm-kml-download-btn').disabled = false;
    document.getElementById('fm-kml-rename-btn').disabled   = false;
    document.getElementById('fm-kml-delete-btn').disabled   = false;
    await showKmlDetail(name);
  } else {
    fm.selCsv = name;
    renderFmFileList('csv');
    document.getElementById('fm-csv-load-btn').disabled     = false;
    document.getElementById('fm-save-csv-btn').disabled     = false;
    document.getElementById('fm-download-csv-btn').disabled = false;
    document.getElementById('fm-csv-rename-btn').disabled   = false;
    document.getElementById('fm-csv-delete-btn').disabled   = false;
    await loadCsvForEditor(name);
  }
}

async function showKmlDetail(name) {
  const detailEl = document.getElementById('fm-kml-detail');
  detailEl.innerHTML = '<div class="fm-detail-empty">Loading…</div>';
  fm.selKmlTrack   = null;
  fm.kmlPlacemarks = [];

  try {
    // Fetch structure info and first-track bounds in parallel
    const [infoRes, trackRes] = await Promise.all([
      fetch(`/api/kml/${encodeURIComponent(name)}/info`),
      fetch(`/api/kml/${encodeURIComponent(name)}`),
    ]);
    const info  = await infoRes.json();
    const track = await trackRes.json();
    if (info.error) throw new Error(info.error);

    fm.kmlPlacemarks = info.placemarks || [];
    fm.selKmlTrack   = info.linestrings[0]?.name ?? null;

    let html = '<div class="fm-kml-detail-inner">';

    // ── Track section ──────────────────────────────────────
    html += '<div class="fm-section-title">Track</div>';
    if (!info.linestrings.length) {
      html += '<div class="fm-dim" style="margin:4px 0 6px">No line tracks in this file</div>';
    } else if (info.linestrings.length === 1) {
      const ls = info.linestrings[0];
      html += '<div class="fm-kml-info">';
      html += `<div class="fm-kml-info-row"><span class="fm-kml-info-label">Name</span><span>${escapeHtml(ls.name)}</span></div>`;
      html += `<div class="fm-kml-info-row"><span class="fm-kml-info-label">Points</span><span>${ls.point_count.toLocaleString()}</span></div>`;
      if (!track.error) {
        html += `<div class="fm-kml-info-row"><span class="fm-kml-info-label">Bounds SW</span><span>${track.bounds[0][0].toFixed(5)}, ${track.bounds[0][1].toFixed(5)}</span></div>`;
        html += `<div class="fm-kml-info-row"><span class="fm-kml-info-label">Bounds NE</span><span>${track.bounds[1][0].toFixed(5)}, ${track.bounds[1][1].toFixed(5)}</span></div>`;
      }
      html += '</div>';
    } else {
      // Multiple LineStrings — radio group
      info.linestrings.forEach((ls, i) => {
        const lsName = escapeHtml(ls.name);
        html += `<label class="fm-track-radio">
          <input type="radio" name="fm-track-sel" value="${lsName}" ${i === 0 ? 'checked' : ''}/>
          <span>${lsName}</span>
          <span class="fm-dim">&nbsp;(${ls.point_count.toLocaleString()} pts)</span>
        </label>`;
      });
    }

    // ── Points / receiver sites section ───────────────────
    if (info.placemarks.length > 0) {
      html += '<div class="fm-section-title fm-section-gap">Points — select receiver sites</div>';
      html += '<div class="fm-placemark-list">';
      info.placemarks.forEach((pm, i) => {
        const precheck = pm.icon_type === 'radiotower';
        const icon = pm.icon_type === 'radiotower' ? '📡'
                   : pm.icon_type === 'camping'      ? '⛺'
                   : pm.icon_type === 'rangerstation' ? '🏠'
                   : '📍';
        html += `<label class="fm-pm-row">
          <input type="checkbox" class="fm-pm-cb" data-idx="${i}" ${precheck ? 'checked' : ''}/>
          <span class="fm-pm-icon">${icon}</span>
          <span class="fm-pm-name">${escapeHtml(pm.name || '(unnamed)')}</span>
          <span class="fm-pm-coords">${pm.lat.toFixed(4)}, ${pm.lon.toFixed(4)}</span>
        </label>`;
      });
      html += '</div>';

      const defName = name.replace(/\.(kml|gpx)$/i, '') + '-receivers.csv';
      html += `<div class="fm-save-rx-row">
        <input id="fm-rx-csv-name" class="ctrl-input" type="text" value="${escapeHtml(defName)}" />
        <button class="btn btn-primary btn-sm" id="fm-save-rx-btn">Save as CSV</button>
      </div>`;
    }

    html += '</div>'; // .fm-kml-detail-inner
    detailEl.innerHTML = html;

    // Wire up track radio buttons
    detailEl.querySelectorAll('input[name="fm-track-sel"]').forEach(r =>
      r.addEventListener('change', e => { fm.selKmlTrack = e.target.value; }));

    // Wire up Save as CSV button
    document.getElementById('fm-save-rx-btn')
      ?.addEventListener('click', () => saveKmlPointsAsCsv(info.placemarks));

  } catch (err) {
    detailEl.innerHTML = `<div class="fm-detail-empty">Error: ${err.message}</div>`;
  }
}

async function saveKmlPointsAsCsv(placemarks) {
  const checked = [...document.querySelectorAll('.fm-pm-cb:checked')]
    .map(cb => placemarks[parseInt(cb.dataset.idx)]);
  if (!checked.length) { alert('Select at least one point.'); return; }

  let filename = (document.getElementById('fm-rx-csv-name')?.value || '').trim();
  if (!filename) { alert('Enter a CSV filename.'); return; }
  if (!filename.endsWith('.csv')) filename += '.csv';

  const lines = [CSV_COLS.join(',')];
  checked.forEach(pm => {
    const row = {
      name:             pm.name,
      longitude:        pm.lon.toFixed(6),
      latitude:         pm.lat.toFixed(6),
      height_agl_m:     '2',
      antenna_gain_dbi: '5.8',
      tx_power_dbm:     '28',
      enabled:          '1',
    };
    lines.push(CSV_COLS.map(c => {
      const v = String(row[c] ?? '');
      return v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(','));
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const fd   = new FormData();
  fd.append('file', new File([blob], filename, { type: 'text/csv' }));

  const saveBtn = document.getElementById('fm-save-rx-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  showTransferSpinner(`Saving ${filename}…`);

  try {
    const res  = await fetch('/api/upload/csv', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Prime the editor so the CSV tab opens ready to use
    fm.editorFile = data.filename;
    fm.editorRows = checked.map(pm => ({
      name: pm.name, longitude: pm.lon.toFixed(6), latitude: pm.lat.toFixed(6),
      height_agl_m: '2', antenna_gain_dbi: '5.8', tx_power_dbm: '28', enabled: '1',
    }));
    fm.selCsv = data.filename;
    await refreshFmFileLists();
    switchFmTab('csv');
    await selectFmFile('csv', data.filename);
    setStatus(`Saved ${checked.length} receiver(s) to ${data.filename} — edit height/gain/power in the CSV tab.`);
  } catch (err) {
    alert(`Save failed: ${err.message}`);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save as CSV'; }
  } finally {
    hideTransferSpinner();
  }
}

async function loadCsvForEditor(name) {
  const emptyEl = document.getElementById('fm-csv-editor-empty');
  const wrapEl  = document.getElementById('fm-editor-wrap');
  emptyEl.style.display = '';
  emptyEl.textContent   = 'Loading…';
  wrapEl.classList.add('hidden');
  try {
    const res  = await fetch(`/api/csv/${encodeURIComponent(name)}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    fm.editorFile = name;
    fm.editorRows = data.rows.map(r => ({ enabled: '1', ...r }));
    emptyEl.style.display = 'none';
    wrapEl.classList.remove('hidden');
    renderFmEditorTable();
  } catch (err) {
    emptyEl.textContent = `Error: ${err.message}`;
  }
}

function renderFmEditorTable() {
  const tbody = document.getElementById('fm-editor-tbody');
  tbody.innerHTML = '';
  fm.editorRows.forEach((row, ri) => {
    const tr = document.createElement('tr');
    CSV_COLS.forEach(col => {
      const td = document.createElement('td');
      if (col === 'enabled') {
        // Render as a centred checkbox; missing value defaults to enabled
        const cb    = document.createElement('input');
        cb.type     = 'checkbox';
        cb.checked  = (row[col] ?? '1') !== '0';
        td.style.textAlign = 'center';
        cb.addEventListener('change', e => { fm.editorRows[ri][col] = e.target.checked ? '1' : '0'; });
        td.appendChild(cb);
      } else if (col === 'tx_power_dbm') {
        const sel = document.createElement('select');
        sel.className = 'editor-select';
        const snapped = _snapPower(row[col] ?? 28);
        TX_POWER_OPTIONS.forEach(([v, label]) => {
          const opt = document.createElement('option');
          opt.value = v; opt.textContent = label;
          if (v === snapped) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', e => { fm.editorRows[ri][col] = e.target.value; });
        td.appendChild(sel);
      } else if (col === 'role') {
        // A blank/missing role displays as "WIDE1 fill-in" (the fallback used
        // everywhere else in the UI, see _rxRole()) — persist that default into
        // the row immediately so an untouched dropdown doesn't save back an
        // empty role that chain-mode analysis can't recognize as WIDE1.
        if (!row[col]) row[col] = 'wide1';
        const sel = document.createElement('select');
        sel.className = 'editor-select';
        [['wide1', 'WIDE1 fill-in'], ['wide2', 'WIDE2 backbone'], ['igate', 'iGate'], ['meshtastic', 'Meshtastic Router']].forEach(([v, label]) => {
          const opt = document.createElement('option');
          opt.value = v; opt.textContent = label;
          if (row[col] === v) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', e => { fm.editorRows[ri][col] = e.target.value; });
        td.appendChild(sel);
      } else {
        const inp = document.createElement('input');
        inp.className = 'editor-input'; inp.value = row[col] ?? '';
        inp.addEventListener('input', e => { fm.editorRows[ri][col] = e.target.value; });
        td.appendChild(inp);
      }
      tr.appendChild(td);
    });
    const tdDel = document.createElement('td');
    const btn   = document.createElement('button');
    btn.className   = 'del-row-btn'; btn.textContent = '✕'; btn.title = 'Delete row';
    btn.addEventListener('click', () => { fm.editorRows.splice(ri, 1); renderFmEditorTable(); });
    tdDel.appendChild(btn); tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// File manager — load into map
// ---------------------------------------------------------------------------

async function loadFmKml() {
  const name = fm.selKml; if (!name) return;
  const qs   = fm.selKmlTrack ? `?track=${encodeURIComponent(fm.selKmlTrack)}` : '';
  const res  = await fetch(`/api/kml/${encodeURIComponent(name)}${qs}`);
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  state.kmlFile   = name;
  state.kmlCoords = data.coordinates;
  clearPath();
  drawPath(data.coordinates, data.bounds);
  checkReady();
  updateSidebarBtns();
  closeFmModal();
}

async function loadFmCsv() {
  const name = fm.selCsv; if (!name) return;
  // Use editor rows if already loaded for this file, otherwise fetch
  let rows = (fm.editorFile === name) ? fm.editorRows : null;
  if (!rows) {
    const res  = await fetch(`/api/csv/${encodeURIComponent(name)}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    rows = data.rows;
  }
  state.csvFile   = name;
  state.receivers = rows.map(r => ({ enabled: '1', ...r }));
  clearReceivers();
  drawReceivers(state.receivers);
  checkReady();
  updateSidebarBtns();
  closeFmModal();
}

// ---------------------------------------------------------------------------
// File manager — save / download / delete
// ---------------------------------------------------------------------------

async function saveFmCsv() {
  if (!fm.editorFile) return;
  showTransferSpinner(`Saving ${fm.editorFile}…`);
  try {
    const res  = await fetch(`/api/csv/${encodeURIComponent(fm.editorFile)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: fm.editorRows }),
    });
    const data = await res.json();
    if (data.ok) {
      setStatus(`Saved ${fm.editorFile}`);
      // Sync receivers if this is the currently loaded CSV
      if (state.csvFile === fm.editorFile) {
        state.receivers = fm.editorRows.map(r => ({ ...r }));
        clearReceivers();
        drawReceivers(state.receivers);
        checkReady();
      }
    } else {
      alert('Save failed');
    }
  } finally {
    hideTransferSpinner();
  }
}

function downloadFmCsv() {
  const lines = [CSV_COLS.join(',')];
  fm.editorRows.forEach(row => {
    lines.push(CSV_COLS.map(c => {
      const v = String(row[c] ?? '');
      return v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(','));
  });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = fm.editorFile || 'receivers.csv';
  a.click();
}

async function deleteFmFile(type) {
  const name = type === 'kml' ? fm.selKml : fm.selCsv;
  if (!name || !confirm(`Delete ${name}?`)) return;
  await fetch(`/api/files/${type}/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (type === 'kml' && state.kmlFile === name) {
    state.kmlFile = null; clearPath(); checkReady(); updateSidebarBtns();
  }
  if (type === 'csv' && state.csvFile === name) {
    state.csvFile = null; clearReceivers(); checkReady(); updateSidebarBtns();
  }
  if (type === 'kml') {
    fm.selKml = null;
    document.getElementById('fm-kml-load-btn').disabled     = true;
    document.getElementById('fm-kml-download-btn').disabled = true;
    document.getElementById('fm-kml-rename-btn').disabled   = true;
    document.getElementById('fm-kml-delete-btn').disabled   = true;
    document.getElementById('fm-kml-detail').innerHTML      =
      '<div class="fm-detail-empty">Select a file to preview</div>';
  } else {
    fm.selCsv = null;
    fm.editorRows = []; fm.editorFile = null;
    document.getElementById('fm-csv-load-btn').disabled     = true;
    document.getElementById('fm-save-csv-btn').disabled     = true;
    document.getElementById('fm-download-csv-btn').disabled = true;
    document.getElementById('fm-csv-rename-btn').disabled   = true;
    document.getElementById('fm-csv-delete-btn').disabled   = true;
    document.getElementById('fm-editor-wrap').classList.add('hidden');
    const emEl = document.getElementById('fm-csv-editor-empty');
    emEl.style.display = ''; emEl.textContent = 'Select a file to edit';
  }
  await refreshFmFileLists();
}

async function renameFmFile(type) {
  const oldName = type === 'kml' ? fm.selKml : fm.selCsv;
  if (!oldName) return;

  // Strip extension so user only types the base name
  const ext     = oldName.includes('.') ? oldName.slice(oldName.lastIndexOf('.')) : '';
  const oldBase = oldName.slice(0, oldName.length - ext.length);
  const newBase = prompt('Rename to:', oldBase);
  if (!newBase || newBase.trim() === oldBase) return;

  const newName = newBase.trim() + ext;
  showTransferSpinner(`Renaming…`);
  try {
    const res  = await fetch(`/api/files/${type}/${encodeURIComponent(oldName)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ new_name: newName }),
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }

    // Update loaded-file state if the renamed file was in use
    if (type === 'kml' && state.kmlFile === oldName) {
      state.kmlFile = data.filename;
      updateSidebarBtns();
    }
    if (type === 'csv' && state.csvFile === oldName) {
      state.csvFile = data.filename;
      if (fm.editorFile === oldName) fm.editorFile = data.filename;
      updateSidebarBtns();
    }

    await refreshFmFileLists();
    await selectFmFile(type, data.filename);
    setStatus(`Renamed to ${data.filename}`);
  } catch (err) {
    alert(`Rename failed: ${err.message}`);
  } finally {
    hideTransferSpinner();
  }
}

function updateSidebarBtns() {
  const kmlName = document.getElementById('kml-mgr-name');
  const csvName = document.getElementById('csv-mgr-name');
  document.getElementById('kml-mgr-btn').classList.toggle('loaded', !!state.kmlFile);
  kmlName.textContent = state.kmlFile || '— not loaded —';
  kmlName.classList.toggle('loaded', !!state.kmlFile);
  document.getElementById('csv-mgr-btn').classList.toggle('loaded', !!state.csvFile);
  csvName.textContent = state.csvFile || '— not loaded —';
  csvName.classList.toggle('loaded', !!state.csvFile);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function clearPath() {
  pathLayer.clearLayers();
  resultLayer.clearLayers();
  interRxLayer.clearLayers();
  state.pathResults = [];
}

function drawPath(coords, bounds) {
  L.polyline(coords.map(([lat, lon]) => [lat, lon]),
    { color: '#888', weight: 3, opacity: 0.8 }).addTo(pathLayer);
  fitBoundsWithReceivers(bounds);
}

function fitBoundsWithReceivers(bounds) {
  const b = L.latLngBounds(bounds[0], bounds[1]);
  state.receivers.forEach(rx =>
    b.extend([parseFloat(rx.latitude), parseFloat(rx.longitude)]));
  map.fitBounds(b.pad(0.1));
}

function clearReceivers() {
  rxLayer.clearLayers();
  resultLayer.clearLayers();
  interRxLayer.clearLayers();
  state.pathResults = [];
  updateLegend();
}

function _rxEnabled(rx) { return (rx.enabled ?? '1') !== '0'; }

function _rxRole(rx) { return (rx.role || 'wide1').toLowerCase(); }

function _rxTooltip(rx, i) {
  const name      = escapeHtml(rx.name || `RX${i + 1}`);
  const enabled   = _rxEnabled(rx);
  const roleLabel = ROLE_LABEL[_rxRole(rx)] || _rxRole(rx).toUpperCase();
  const badge     = enabled ? '' : '<br><span style="color:#e05252;font-size:10px">⊘ disabled — excluded from analysis</span>';
  return `<b>${name}</b> <span style="font-size:10px;color:#a0a8c0">[${roleLabel}]</span>${badge}<br>${rx.height_agl_m || 0} m AGL · ${rx.antenna_gain_dbi || 0} dBi gain<br><span style="color:#7a82a0;font-size:10px">drag to reposition</span>`;
}

// Create and add a single receiver marker at index i (no bounds change)
function _addRxMarker(rx, i) {
  const lat       = parseFloat(rx.latitude);
  const lon       = parseFloat(rx.longitude);
  const color     = rxColor(i);
  const disabled  = !_rxEnabled(rx);
  const role      = _rxRole(rx);
  const roleClass = role === 'wide2'       ? ' rx-wide2'
                 : role === 'igate'       ? ' rx-igate'
                 : role === 'meshtastic'  ? ' rx-meshtastic'
                 : '';
  const icon  = L.divIcon({
    className:     '',
    html:          `<div class="rx-marker${disabled ? ' rx-disabled' : ''}${roleClass}" id="rx-dot-${i}" style="background:${color}"></div>`,
    iconSize:      [20, 20],
    iconAnchor:    [10, 10],
    tooltipAnchor: [0, -12],
  });
  L.marker([lat, lon], { icon, draggable: true })
    .bindTooltip(_rxTooltip(rx, i), { direction: 'top' })
    .on('dragend', async function (e) {
      const { lat: newLat, lng: newLon } = e.target.getLatLng();
      await updateReceiverPosition(i, newLat, newLon, e.target);
    })
    .on('contextmenu', function (e) {
      L.DomEvent.stopPropagation(e);
      e.originalEvent.preventDefault();
      _showRxContextMenu(e.originalEvent, i);
    })
    .addTo(rxLayer);
}

function drawReceivers(receivers) {
  receivers.forEach((rx, i) => _addRxMarker(rx, i));

  // Fit to receivers + KML track (whichever are loaded)
  const pts = [
    ...state.kmlCoords.map(([la, lo]) => [la, lo]),
    ...receivers.map(rx => [parseFloat(rx.latitude), parseFloat(rx.longitude)]),
  ];
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.1));

  updateLegend();
}

// ---------------------------------------------------------------------------
// Receiver drag-to-reposition
// ---------------------------------------------------------------------------

async function updateReceiverPosition(rxIdx, lat, lon, markerObj) {
  // Round to 6 dp (matching server _rc precision)
  state.receivers[rxIdx].latitude  = rc(lat).toFixed(6);
  state.receivers[rxIdx].longitude = rc(lon).toFixed(6);

  // If a terrain profile for a link involving this receiver is open, close it
  const profileInvolves = state.currentProfileRxIdx === rxIdx
    || state.currentProfileRx1Idx === rxIdx
    || state.currentProfileRx2Idx === rxIdx;
  if (profileInvolves) {
    state.currentProfileData   = null;
    state.currentProfileRxIdx  = -1;
    state.currentProfileRx1Idx = -1;
    state.currentProfileRx2Idx = -1;
    document.getElementById('profile-canvas').style.display = 'none';
    document.getElementById('profile-empty').style.display  = '';
    document.getElementById('profile-empty').textContent    = 'Click the path or an inter-receiver link to view terrain profile';
    document.getElementById('profile-link-label').classList.add('hidden');
    document.getElementById('profile-rx-sidebar').classList.add('hidden');
  }

  // Remove only inter-receiver polylines that involve the moved receiver
  const toRemove = [];
  interRxLayer.eachLayer(layer => {
    if (layer.options.rx1_idx === rxIdx || layer.options.rx2_idx === rxIdx)
      toRemove.push(layer);
  });
  toRemove.forEach(l => interRxLayer.removeLayer(l));

  // Drop stored results for pairs involving this receiver so they can be refilled
  state.interRxResults = state.interRxResults.filter(
    r => r.rx1_idx !== rxIdx && r.rx2_idx !== rxIdx
  );

  if (!state.csvFile) {
    setStatus('Receiver moved — no CSV file loaded, position not saved.');
    return;
  }

  const name = state.receivers[rxIdx].name || `RX${rxIdx + 1}`;
  showTransferSpinner(`Saving ${name} position…`);

  try {
    const res  = await fetch(`/api/csv/${encodeURIComponent(state.csvFile)}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ rows: state.receivers }),
    });
    const data = await res.json();

    if (data.ok) {
      // Flash green ring on the marker div to confirm save
      const dot = document.getElementById(`rx-dot-${rxIdx}`);
      if (dot) {
        dot.classList.add('rx-saved');
        setTimeout(() => dot.classList.remove('rx-saved'), 1200);
      }
      // Refresh tooltip with updated coords
      if (markerObj) markerObj.setTooltipContent(_rxTooltip(state.receivers[rxIdx], rxIdx));

      // Sync FM editor table if it is currently showing this CSV
      if (fm.editorFile === state.csvFile && fm.editorRows[rxIdx]) {
        fm.editorRows[rxIdx].latitude  = state.receivers[rxIdx].latitude;
        fm.editorRows[rxIdx].longitude = state.receivers[rxIdx].longitude;
        renderFmEditorTable();
      }

      // Recalculate links for the moved receiver only; skipClear keeps other links visible
      if (state.receivers.filter(_rxEnabled).length >= 2) {
        setStatus(`${name} saved · recalculating receiver links…`);
        startAnalysis('links', { skipClear: true });
      } else {
        setStatus(`${name} repositioned and saved.`);
      }
    } else {
      setStatus(`${name} moved but save failed — check server logs.`);
    }
  } catch (err) {
    setStatus(`Save error: ${err.message}`);
  } finally {
    hideTransferSpinner();
  }
}

function _iaRenderHeatMap() {
  if (state.iaHeatLayer) { map.removeLayer(state.iaHeatLayer); state.iaHeatLayer = null; }
  const scores = Object.entries(state.iaCandScores)
    .map(([idx, d]) => ({ idx: +idx, pct: d.pct || 0 }))
    .filter(d => d.pct > 0)
    .sort((a, b) => b.pct - a.pct);
  if (scores.length === 0) return;
  const cutoff = Math.ceil(scores.length * 0.20);
  const top    = scores.slice(0, cutoff);
  const maxPct = top[0].pct;
  const pts = [];
  top.forEach(({ idx, pct }) => {
    const m = state.iaCandidateMarkers[idx];
    if (!m) return;
    const ll = m.getLatLng();
    pts.push([ll.lat, ll.lng, pct / maxPct]);
  });
  if (pts.length === 0) return;
  state.iaHeatLayer = L.heatLayer(pts, {
    radius: 35, blur: 25, maxZoom: 15,
    gradient: { 0.3: '#2196f3', 0.6: '#ff9800', 1.0: '#f44336' },
    max: 1.0,
  }).addTo(map);
  updateLegend();
}

function updateLegend() {
  const el = document.getElementById('map-legend');
  if (!el) return;
  const hasRx            = state.receivers && state.receivers.length > 0;
  const hasCoverage      = state.pathResults && state.pathResults.length > 0;
  const hasIa            = state.iaSuggestions && state.iaSuggestions.length > 0;
  const hasIaTrack       = state.iaAdvisorTrackPts && state.iaAdvisorTrackPts.length > 0;
  const hasIaCandidates  = state.iaCandidateMarkers && Object.keys(state.iaCandidateMarkers).length > 0;
  const hasIaRoads       = state.iaRoadsLayer      && state.iaRoadsLayer.getLayers().length > 0;
  const hasIaExclusions  = state.iaExclusionsLayer && state.iaExclusionsLayer.getLayers().length > 0;
  const hasIaHotZones    = state.iaHotZoneLayer    && state.iaHotZoneLayer.getLayers().length > 0;
  const hasIaTrackPrev   = state.iaTrackPreviewLayer && state.iaTrackPreviewLayer.getLayers().length > 0;
  const hasIaHeat        = !!state.iaHeatLayer;
  const hasHeatMap       = state.heatMapLayer && state.heatMapLayer.getLayers().length > 0;
  if (!hasRx && !hasCoverage && !hasIa && !hasIaTrack && !hasIaCandidates
      && !hasIaRoads && !hasIaExclusions && !hasIaHotZones && !hasIaTrackPrev
      && !hasIaHeat && !hasHeatMap) {
    el.style.display = 'none'; return;
  }
  el.style.display = '';
  const lines = [];
  if (hasRx) {
    lines.push('<div class="legend-title">Receivers</div>');
    const roles = new Set(state.receivers.map(r => _rxRole(r)));
    if (roles.has('wide1'))
      lines.push('<div class="legend-entry"><div class="legend-marker lm-circle" style="color:#4f8ef7;background:rgba(79,142,247,0.25)"></div><span>WIDE1 fill-in</span></div>');
    if (roles.has('wide2'))
      lines.push('<div class="legend-entry"><div class="legend-marker lm-diamond" style="color:#4f8ef7;background:rgba(79,142,247,0.25)"></div><span>WIDE2 backbone</span></div>');
    if (roles.has('igate'))
      lines.push('<div class="legend-entry"><div class="legend-marker lm-square" style="color:#4f8ef7;background:rgba(79,142,247,0.25)"></div><span>iGate</span></div>');
    if (roles.has('meshtastic'))
      lines.push('<div class="legend-entry"><div class="legend-marker lm-square" style="color:#4f8ef7;background:rgba(79,142,247,0.25)"></div><span>Meshtastic Router</span></div>');
  }
  if (hasCoverage) {
    if (hasRx) lines.push('<div class="legend-sep"></div>');
    lines.push('<div class="legend-title">Track Coverage</div>');
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:#4caf7d"></div><span>Covered</span></div>');
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:#e05252"></div><span>Not covered</span></div>');
  }
  if (hasIaTrack) {
    if (hasRx || hasCoverage) lines.push('<div class="legend-sep"></div>');
    lines.push('<div class="legend-title">Advisor Coverage</div>');
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:#4caf50"></div><span>Covered by suggestions</span></div>');
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:#ff9800"></div><span>Covered by existing</span></div>');
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:#e05252"></div><span>Uncovered</span></div>');
  }
  if (hasIa) {
    if (hasRx || hasCoverage || hasIaTrack) lines.push('<div class="legend-sep"></div>');
    lines.push('<div class="legend-title">Suggested Sites</div>');
    lines.push('<div class="legend-entry"><div class="legend-marker lm-ia">1</div><span>Road (Tier 1)</span></div>');
    lines.push('<div class="legend-entry"><div class="legend-marker lm-ia" style="background:#ff8f00;border-color:#ff8f00">1</div><span>Hilltop (Tier 2)</span></div>');
    lines.push('<div class="legend-entry"><div class="legend-marker lm-ia" style="background:#2e7d32;border-color:#2e7d32">1</div><span>On-Route (Tier 3)</span></div>');
  }
  if (hasIaCandidates) {
    if (hasRx || hasCoverage || hasIaTrack || hasIa) lines.push('<div class="legend-sep"></div>');
    lines.push('<div class="legend-title">Candidate Sites</div>');
    lines.push('<div class="legend-entry"><div class="legend-marker lm-circle" style="color:#888;background:rgba(136,136,136,0.55)"></div><span>Scoring…</span></div>');
    lines.push('<div class="legend-entry"><div class="legend-marker lm-circle" style="color:#9c27b0;background:rgba(156,39,176,0.9)"></div><span>Best so far</span></div>');
    lines.push(`<div class="legend-entry"><div class="legend-marker lm-circle" style="color:#4caf50;background:rgba(76,175,80,0.7)"></div><span>Meets min. contribution</span></div>`);
    lines.push('<div class="legend-entry"><div class="legend-marker lm-circle" style="color:#e05252;background:rgba(224,82,82,0.7)"></div><span>Below min. contribution</span></div>');
    lines.push('<div class="legend-entry"><div class="legend-marker lm-circle" style="color:#555;background:rgba(85,85,85,0.7)"></div><span>Backbone blocked</span></div>');
  }
  if (hasIaTrackPrev) {
    lines.push('<div class="legend-sep"></div>');
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:repeating-linear-gradient(90deg,#888 0,#888 7px,transparent 7px,transparent 12px)"></div><span>Track (analyzing…)</span></div>');
  }
  if (hasIaRoads) {
    if (!hasIaTrackPrev) lines.push('<div class="legend-sep"></div>');
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:#555;height:2px;margin:5px 0"></div><span>Road/trail network</span></div>');
  }
  if (hasIaExclusions) {
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:rgba(231,76,60,0.25);border:1px solid #c0392b"></div><span>Water / building (excluded)</span></div>');
  }
  if (hasIaHotZones) {
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:rgba(243,156,18,0.2);border:1px solid #e67e22;border-radius:50%"></div><span>Hot-zone cluster</span></div>');
  }
  if (hasIaHeat) {
    lines.push('<div class="legend-sep"></div>');
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:linear-gradient(90deg,#2196f3,#ff9800,#f44336)"></div><span>RF score heat map (top 20%)</span></div>');
  }
  if (hasHeatMap) {
    if (lines.length) lines.push('<div class="legend-sep"></div>');
    const _hmSens   = parseFloat(document.getElementById('rx-sens').value)     || -135;
    const _hmFade   = parseFloat(document.getElementById('fade-margin').value) || 0;
    const _hmThresh = _hmSens + _hmFade;
    lines.push('<div class="legend-title">Coverage Heat Map</div>');
    lines.push(`<div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">Margin above your ${_hmThresh} dBm threshold (sensitivity + fade margin)</div>`);
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:#2196f3"></div><span>0–10 dB — weak, near threshold</span></div>');
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:linear-gradient(90deg,#2196f3,#ff9800)"></div><span>10–20 dB — moderate margin</span></div>');
    lines.push('<div class="legend-entry"><div class="legend-swatch" style="background:linear-gradient(90deg,#ff9800,#f44336)"></div><span>20–30+ dB — strong margin</span></div>');
    lines.push('<div style="font-size:11px;color:var(--text-dim);margin-top:4px">Uncovered / blocked cells are left transparent</div>');
  }
  el.innerHTML = lines.join('');
  if (document.getElementById('tab-hardware')?.classList.contains('active')) renderHardwareTab();
}

const ROLE_ORDER = ['wide2', 'wide1', 'igate', 'meshtastic'];

function _powerLabel(dbm) {
  const snapped = _snapPower(dbm ?? 28);
  return (TX_POWER_OPTIONS.find(([v]) => v === snapped) || [0, `${snapped} dBm`])[1];
}

function _buildRosterGroups() {
  const rxs      = state.receivers || [];
  const enabled  = rxs.filter(_rxEnabled);
  const excluded = rxs.filter(r => !_rxEnabled(r)).map(r => escapeHtml(r.name));

  const byRole = {};
  enabled.forEach(r => {
    const role = _rxRole(r);
    (byRole[role] = byRole[role] || []).push(r);
  });

  const roles = Object.keys(byRole).sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a), ib = ROLE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const groups = roles.map(role => ({
    role,
    label: ROLE_LABEL[role] || role.toUpperCase(),
    rows: byRole[role]
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(r => ({
        name:   escapeHtml(r.name || '(unnamed)'),
        gps:    `${parseFloat(r.latitude).toFixed(5)}, ${parseFloat(r.longitude).toFixed(5)}`,
        height: `${r.height_agl_m ?? '?'} m`,
        gain:   `${r.antenna_gain_dbi ?? '?'} dBi`,
        power:  _powerLabel(r.tx_power_dbm),
        role:   ROLE_LABEL[role] || role.toUpperCase(),
      })),
  }));

  return { groups, total: enabled.length, excluded };
}

function _rosterTableHtml(rows) {
  const trs = rows.map(r => `<tr>
      <td>${r.name}</td>
      <td>${r.gps}</td>
      <td>${r.height}</td>
      <td>${r.gain}</td>
      <td>${r.power}</td>
      <td></td>
      <td></td>
    </tr>`).join('');
  return `<table class="results-table roster-table">
      <colgroup>
        <col style="width:14ch"><col style="width:20ch"><col style="width:8ch">
        <col style="width:8ch"><col style="width:14ch"><col style="width:15ch"><col style="width:15ch">
      </colgroup>
      <thead><tr><th>Location</th><th>GPS</th><th>Height</th><th>Antenna</th><th>Power</th><th>Who</th><th>Tactical</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>`;
}

function renderHardwareTab() {
  const empty = document.getElementById('hardware-empty');
  const grid  = document.getElementById('hw-grid');
  if (!empty || !grid) return;

  const rxs = state.receivers || [];
  const { groups, excluded } = _buildRosterGroups();

  if (!groups.length) {
    empty.classList.remove('hidden');
    empty.textContent = rxs.length ? 'No enabled receivers' : 'No receivers loaded';
    grid.classList.add('hidden');
    grid.innerHTML = '';
    setPrintSummaryEnabled(false);
    return;
  }
  empty.classList.add('hidden');
  grid.classList.remove('hidden');
  setPrintSummaryEnabled(true);

  const sections = groups.map(g => `<div class="hw-role-section">
      <div class="hw-section-title">${g.label} — ${g.rows.length} site${g.rows.length === 1 ? '' : 's'}</div>
      ${_rosterTableHtml(g.rows)}
    </div>`).join('');

  const excludedNote = excluded.length
    ? `<div class="hw-excluded-note">Excluded (disabled) receivers: ${excluded.join(', ')}</div>`
    : '';

  grid.innerHTML = sections + excludedNote;
}

function setPrintSummaryEnabled(on) {
  const btn = document.getElementById('print-summary-btn');
  if (btn) btn.disabled = !on;
}

function buildPrintReport() {
  const el = document.getElementById('print-report');
  if (!el) return;

  const { groups, excluded } = _buildRosterGroups();
  if (!groups.length) { el.innerHTML = ''; return; }

  const sections = groups.map(g => `<div class="hw-role-section">
      <div class="hw-section-title">${g.label} — ${g.rows.length} site${g.rows.length === 1 ? '' : 's'}</div>
      ${_rosterTableHtml(g.rows)}
    </div>`).join('');

  const excludedNote = excluded.length
    ? `<div class="hw-excluded-note">Excluded (disabled) receivers: ${excluded.join(', ')}</div>`
    : '';

  el.innerHTML = `
    <div class="print-report-header">
      <h1>Deployment Summary</h1>
      <div class="print-report-meta">Generated ${new Date().toLocaleString()}</div>
    </div>
    <div class="print-map-frame">
      <img id="print-map-img" class="print-map-image hidden" alt="Map view" />
      <div id="print-map-fallback" class="print-map-fallback hidden"></div>
    </div>
    <div class="print-report-body">${sections}${summary}${excludedNote}</div>`;
}

const PRINT_MAP_W = 1600, PRINT_MAP_H = 960;

// Three earlier attempts tried to resize/reframe the LIVE interactive map at
// print time (beforeprint handlers, then a ResizeObserver) -- both passed
// testing here but had no effect on real printed/PDF output, and a
// client-side canvas screenshot would hit the same wall since the tile
// layers aren't loaded in CORS mode (canvas.toBlob() would throw on a
// tainted canvas). Instead: render a plain PNG server-side and embed it as
// a normal <img> before window.print() -- this never touches the live map,
// so there's no print-event-timing dependency to get wrong.
//
// L.latLngBounds(...) and map.project(...) are pure calculations -- neither
// requires the map to be resized, rendered, or even visible -- so this can
// run in a normal click handler. (map.getBoundsZoom() was tried first, but
// its padding argument subtracts from the map's CURRENT on-screen container
// size rather than accepting an arbitrary target size -- not what's needed
// here, since the whole point is to be independent of the live viewport.
// map.project(latlng, zoom) instead does a pure CRS coordinate transform.)
function _boundsZoomForSize(bounds, width, height, maxZoom) {
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  for (let z = maxZoom; z >= 0; z--) {
    const p1 = map.project(sw, z), p2 = map.project(ne, z);
    if (Math.abs(p2.x - p1.x) <= width && Math.abs(p2.y - p1.y) <= height) return z;
  }
  return 0;
}

// Same "fit everything into view" content (track + receivers) as the app
// already uses elsewhere.
function _buildPrintMapPayload() {
  const allPts = [
    ...(state.kmlCoords || []),
    ...(state.receivers || []).map(rx => [parseFloat(rx.latitude), parseFloat(rx.longitude)]),
  ].filter(([lat, lon]) => isFinite(lat) && isFinite(lon));
  if (!allPts.length) return null;

  const bounds = L.latLngBounds(allPts).pad(0.1);
  const zoom   = _boundsZoomForSize(bounds, PRINT_MAP_W, PRINT_MAP_H, 19);
  const center = bounds.getCenter();

  return {
    basemap: document.getElementById('basemap-select').value,
    center: [center.lat, center.lng],
    zoom, width: PRINT_MAP_W, height: PRINT_MAP_H,
    track: (state.kmlCoords || []).filter(([lat, lon]) => isFinite(lat) && isFinite(lon)),
    markers: (state.receivers || [])
      .map((rx, i) => ({
        lat: parseFloat(rx.latitude), lon: parseFloat(rx.longitude),
        color: rxColorHex(i),
        shape: { wide2: 'diamond', igate: 'square', meshtastic: 'triangle' }[_rxRole(rx)] || 'circle',
        enabled: _rxEnabled(rx),
      }))
      .filter(m => isFinite(m.lat) && isFinite(m.lon)),
  };
}

let _printMapObjectUrl = null;

async function _renderPrintMapImage() {
  const img = document.getElementById('print-map-img');
  const fallback = document.getElementById('print-map-fallback');
  if (!img || !fallback) return;

  const payload = _buildPrintMapPayload();
  if (!payload) {
    img.classList.add('hidden');
    fallback.textContent = 'No track or receivers loaded -- nothing to show on map.';
    fallback.classList.remove('hidden');
    return;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const resp = await fetch('/api/print-map-image', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    if (_printMapObjectUrl) URL.revokeObjectURL(_printMapObjectUrl);
    _printMapObjectUrl = URL.createObjectURL(blob);
    img.src = _printMapObjectUrl;
    img.classList.remove('hidden');
    fallback.classList.add('hidden');
  } catch (err) {
    console.error('Print map image failed:', err);
    img.classList.add('hidden');
    fallback.textContent = 'Map image unavailable (network error) -- roster data below is still accurate.';
    fallback.classList.remove('hidden');
  } finally {
    clearTimeout(timer);
  }
}

async function printDeploymentSummary() {
  buildPrintReport();
  await _renderPrintMapImage();
  window.print();
}

function updateSingleRxSelect() {
  const sel = document.getElementById('single-rx-select');
  const row = document.getElementById('single-rx-row');
  const prev = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  state.receivers.forEach(rx => {
    const opt = document.createElement('option');
    opt.value = rx.name;
    opt.textContent = rx.name;
    sel.add(opt);
  });
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  row.style.display = state.receivers.length > 0 ? 'flex' : 'none';
}

function checkReady() {
  updateSingleRxSelect();
  const trackBtn = document.getElementById('analyze-track-btn');
  const linksBtn = document.getElementById('analyze-links-btn');

  if (state.analysisRunning) {
    const isTrack = state.analysisMode === 'track';
    // Running button → Stop; other button → disabled
    trackBtn.disabled    = !isTrack;
    linksBtn.disabled    = isTrack;
    trackBtn.textContent = isTrack  ? '■ Stop' : '▶ Track Coverage';
    linksBtn.textContent = !isTrack ? '■ Stop' : '▶ Receiver Links';
    trackBtn.classList[isTrack  ? 'replace' : 'replace']('btn-primary', isTrack  ? 'btn-danger' : 'btn-primary');
    linksBtn.classList[!isTrack ? 'replace' : 'replace']('btn-primary', !isTrack ? 'btn-danger' : 'btn-primary');
    // Simpler: set classes directly
    trackBtn.className = `btn btn-full ${isTrack  ? 'btn-danger' : 'btn-primary'}`;
    linksBtn.className = `btn btn-full ${!isTrack ? 'btn-danger' : 'btn-primary'}`;
  } else {
    const trackReady = !!state.kmlFile && !!state.csvFile;
    const linksReady = !!state.csvFile && state.receivers.length >= 2;
    trackBtn.disabled    = !trackReady;
    linksBtn.disabled    = !linksReady;
    trackBtn.textContent = '▶ Track Coverage';
    linksBtn.textContent = '▶ Receiver Links';
    trackBtn.className   = 'btn btn-full btn-primary';
    linksBtn.className   = 'btn btn-full btn-primary';
  }
}

// ---------------------------------------------------------------------------
// RF Analysis via fetch + SSE stream
// ---------------------------------------------------------------------------

document.getElementById('analyze-track-btn').addEventListener('click', () => {
  if (state.analysisRunning) state.abortController?.abort();
  else startAnalysis('track');
});
document.getElementById('analyze-links-btn').addEventListener('click', () => {
  if (state.analysisRunning) state.abortController?.abort();
  else startAnalysis('links');
});


// Bumped by every startAnalysis() call; segment-layer flushes deferred to a
// requestAnimationFrame (see flushSeg below) check this so a straggling
// flush from an aborted/superseded run can never draw onto a layer that a
// newer run has already cleared and started repopulating.
let _analysisRunId = 0;

function startAnalysis(mode, opts = {}) {
  if (state.analysisRunning) return;
  const runId = ++_analysisRunId;

  // Clear only the layer(s) this mode will repopulate.
  // skipClear=true lets a caller pre-clear selectively (e.g. receiver drag).
  if (!opts.skipClear) {
    if (mode === 'track') {
      resultLayer.clearLayers();
      state.pathResults    = [];
      state.interRxResults = [];
    } else if (mode === 'links') {
      interRxLayer.clearLayers();
      state.interRxResults = [];
    }
  }

  // Reset save-related state and hide the save row
  state.lastAnalysisStats    = null;
  state.lastAnalysisTotalPct = null;
  state.lastAnalysisParams   = null;
  document.getElementById('save-analysis-row').classList.add('hidden');

  state.currentProfileData   = null;
  state.currentPathPoint     = null;
  state.currentProfileRxIdx  = -1;
  state.currentProfileRx1Idx = -1;
  state.currentProfileRx2Idx = -1;
  document.getElementById('profile-canvas').style.display   = 'none';
  document.getElementById('profile-empty').style.display    = '';
  document.getElementById('profile-empty').textContent      = 'Click the path or an inter-receiver link to view terrain profile';
  document.getElementById('profile-link-label').textContent = '';
  document.getElementById('profile-link-label').classList.add('hidden');
  document.getElementById('profile-rx-sidebar').classList.add('hidden');
  document.getElementById('map-signal-panel').classList.add('hidden');
  if (mode === 'track') hideResults();

  state.lastFreqMhz     = parseFloat(document.getElementById('freq-select').value);
  state.rfStartTime     = null;
  state.analysisRunning = true;
  state.analysisMode    = mode;
  state.abortController = new AbortController();

  // Snapshot RF parameters for the save feature
  state.lastAnalysisParams = {
    freq_mhz:        state.lastFreqMhz,
    tx_power_dbm:    parseFloat(document.getElementById('tx-power').value),
    tx_gain_dbi:     parseFloat(document.getElementById('tx-gain').value),
    sensitivity_dbm: parseFloat(document.getElementById('rx-sens').value),
    veg_type:        document.getElementById('veg-loss').value,
    fade_margin_db:  parseFloat(document.getElementById('fade-margin').value) || 0,
    mode,
    chain_mode:      document.getElementById('chain-mode-toggle').checked,
    single_rx:       mode === 'track' ? (document.getElementById('single-rx-select').value || null) : null,
  };

  checkReady();
  showProgress(true);
  setProgress('Starting…', 0);
  setStatus('');

  const _focusedRx = mode === 'track' && document.getElementById('single-rx-select').value;
  const params = {
    kml_file:        state.kmlFile,
    csv_file:        state.csvFile,
    // Send receivers directly so the server always uses the live UI state
    // (enabled flags, dragged positions) without requiring an explicit CSV save first.
    // Focus filter only applies to track coverage — links always run against all receivers.
    receivers:       _focusedRx
                       ? state.receivers.map(rx => rx.name === _focusedRx ? rx : { ...rx, enabled: '0' })
                       : state.receivers,
    freq_mhz:        state.lastFreqMhz,
    tx_power_dbm:    parseFloat(document.getElementById('tx-power').value),
    tx_gain_dbi:     parseFloat(document.getElementById('tx-gain').value),
    sensitivity_dbm: parseFloat(document.getElementById('rx-sens').value),
    veg_type:        document.getElementById('veg-loss').value,
    fade_margin_db:  parseFloat(document.getElementById('fade-margin').value) || 0,
    mode,
    chain_mode:      document.getElementById('chain-mode-toggle').checked,
  };

  // Segment drawing state
  let segColor = null;
  let segPts   = [];

  // SSE 'points_batch' events can carry many points, each of which may end a
  // segment; adding each finished polyline to the map synchronously as it's
  // built can cause layout thrashing when a batch has several color changes.
  // Collect finished polylines and add them to resultLayer at most once per
  // animation frame instead. Guarded by runId so a flush left over from an
  // aborted/superseded run never lands on a layer a newer run already owns.
  let _pendingSegLayers = [];
  let _flushLayersRaf   = null;
  const _schedulePendingLayerFlush = () => {
    if (_flushLayersRaf !== null) return;
    _flushLayersRaf = requestAnimationFrame(() => {
      _flushLayersRaf = null;
      const pending = _pendingSegLayers;
      _pendingSegLayers = [];
      if (runId !== _analysisRunId) return;
      pending.forEach(poly => poly.addTo(resultLayer));
    });
  };

  const flushSeg = nextPt => {
    if (segPts.length > 1) {
      const poly = L.polyline(segPts, { color: segColor, weight: 5, opacity: 0.85 });
      poly.on('click', e => {
        const nr = findNearestResult(rc(e.latlng.lat), rc(e.latlng.lng));
        if (nr && nr.best_rx_idx >= 0) showPathPointProfile(nr);
      });
      _pendingSegLayers.push(poly);
      _schedulePendingLayerFlush();
    }
    segPts = nextPt ? [nextPt] : [];
  };

  fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: state.abortController.signal,
  }).then(res => {
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    // ctx is created once with getter accessors so ctx.segColor / ctx.segPts
    // always reflect the live outer variables — prevents the stale-snapshot
    // gap bug where every point after the first in a batch saw a false color
    // change because the value-snapshot { segColor } never updated mid-loop.
    const ctx = {
      get segColor() { return segColor; },
      get segPts()   { return segPts;   },
      flushSeg,
      setColor: c => { segColor = c; },
      setPts:   p => { segPts   = p; },
    };

    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { flushSeg(null); finishAnalysis(); return; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(line => {
          if (!line.startsWith('data: ')) return;
          try { handleSSE(JSON.parse(line.slice(6)), ctx); }
          catch { /* ignore parse errors */ }
        });
        pump();
      }).catch(() => { flushSeg(null); finishAnalysis(); });
    }
    pump();
  }).catch(err => {
    if (err.name === 'AbortError') {
      setStatus('Analysis stopped.');
    } else {
      setStatus(`Error: ${err.message}`);
    }
    finishAnalysis();
  });
}

function handleSSE(evt, ctx) {
  switch (evt.type) {

    case 'status':
      setStatus(evt.message);
      break;

    case 'path_info':
      setStatus(`${evt.total_points} path points · ${evt.total_receivers} receivers · ${evt.terrain_spacing_m} m terrain spacing`);
      break;

    case 'elev_start':
      setStatus(evt.message);
      setProgress('Downloading terrain tiles…', 0);
      break;

    case 'elev_progress':
      if (evt.total > 0)
        setProgress(evt.message || `Terrain: ${evt.current}/${evt.total}`,
                    (evt.current / evt.total) * 40);
      break;

    case 'points_batch': {
      // Record time when first batch arrives for time-remaining estimate
      if (!state.rfStartTime) state.rfStartTime = Date.now();
      const elapsed = (Date.now() - state.rfStartTime) / 1000;
      const pct = 40 + (evt.progress / evt.total) * 55;
      let progressLabel = `RF analysis: ${evt.progress}/${evt.total}`;
      if (elapsed > 4 && evt.progress > 10) {
        const secsLeft = Math.round((evt.total - evt.progress) / (evt.progress / elapsed));
        progressLabel += secsLeft > 60
          ? `  ·  ${Math.floor(secsLeft / 60)}m ${secsLeft % 60}s left`
          : `  ·  ~${secsLeft}s left`;
      }
      setProgress(progressLabel, pct);

      if (evt.stats && evt.stats.length)
        renderResults(evt.stats, evt.total_coverage_pct ?? 0, false, evt.track_dist_m ?? 0);

      evt.points.forEach(pt => {
        // Store for cursor hover RSSI
        state.pathResults.push(pt);

        // covered → receiver colour  |  blocked (terrain/veg) → deep orange  |  faded → dark grey
        const color  = pt.coverage   ? rxColor(pt.best_rx_idx)
                     : pt.hard_fail  ? '#ff5722'   // terrain/veg blocked — deep orange
                     :                 '#505060';   // below threshold / faded — dark blue-grey
        const latlng = [pt.lat, pt.lon];

        if (color !== ctx.segColor) {
          ctx.flushSeg(latlng);
          ctx.setColor(color);
          ctx.setPts([latlng]);
        } else {
          ctx.segPts.push(latlng);
        }
      });
      break;
    }

    case 'inter_rx': {
      // Store all link results regardless of good_link for save/restore
      state.interRxResults.push({
        rx1_idx:   evt.rx1_idx,
        rx2_idx:   evt.rx2_idx,
        rssi:      evt.rssi,
        los:       evt.los,
        dist_km:   evt.dist_km,
        diff_db:   evt.diff_db,
        veg_db:    evt.veg_db,
        hard_fail: evt.hard_fail,
        good_link: evt.good_link,
      });
      if (!evt.good_link) break;
      const rx1 = state.receivers[evt.rx1_idx];
      const rx2 = state.receivers[evt.rx2_idx];
      if (!rx1 || !rx2) break;
      // Defensive: never draw a link involving a disabled receiver
      if (!_rxEnabled(rx1) || !_rxEnabled(rx2)) break;

      const r1 = _rxRole(rx1);
      const r2 = _rxRole(rx2);
      // wide1↔wide1 is not a valid APRS relay path — skip drawing
      if (r1 === 'wide1' && r2 === 'wide1') break;
      // Backbone links (WIDE1 ↔ WIDE2 or WIDE1 ↔ iGate) get a distinct amber dashed style
      const isBackbone = (r1 === 'wide1' && (r2 === 'wide2' || r2 === 'igate'))
                      || (r2 === 'wide1' && (r1 === 'wide2' || r1 === 'igate'));
      const color  = isBackbone ? '#ffb300' : rxColor(evt.rx1_idx);
      const weight = isBackbone ? 3.5 : 2.5;
      const opts   = { color, weight, opacity: isBackbone ? 0.95 : 0.75,
                       rx1_idx: evt.rx1_idx, rx2_idx: evt.rx2_idx };
      if (isBackbone) opts.dashArray = '9 5';

      const roleDesc = r => (ROLE_LABEL[r] || r.toUpperCase());
      const rx1Name = escapeHtml(rx1.name), rx2Name = escapeHtml(rx2.name);
      const linkLabel = isBackbone
        ? `Backbone: ${rx1Name} (${roleDesc(r1)}) ↔ ${rx2Name} (${roleDesc(r2)})`
        : `${rx1Name} ↔ ${rx2Name}`;

      const pl = L.polyline(
        [[parseFloat(rx1.latitude), parseFloat(rx1.longitude)],
         [parseFloat(rx2.latitude), parseFloat(rx2.longitude)]],
        opts
      );
      pl.bindTooltip(
        `${linkLabel}<br>${evt.rssi} dBm · ${evt.dist_km} km · diff: ${evt.diff_db} dB`,
        { sticky: true }
      );
      pl.on('click', () => showTerrainProfile(rx1, rx2, evt.rx1_idx, evt.rx2_idx));
      pl.addTo(interRxLayer);
      break;
    }

    case 'complete':
      ctx.flushSeg(null);
      if (evt.mode !== 'links') renderResults(evt.stats, evt.total_coverage_pct, true, evt.track_dist_m ?? 0);
      setProgress('Complete', 100);
      setStatus(evt.mode === 'links'
        ? 'Receiver link analysis complete.'
        : evt.chain_mode
          ? 'APRS chain analysis complete. Covered = tracker → WIDE1 (requires WIDE2/iGate link) or direct to WIDE2/iGate. Backbone links shown in amber.'
          : 'Track coverage complete. Click an inter-receiver link to view terrain profile.');
      // Store stats and show save row
      state.lastAnalysisStats    = evt.stats || [];
      state.lastAnalysisTotalPct = evt.total_coverage_pct ?? null;
      _showSaveRow();
      finishAnalysis();
      break;

    case 'error':
      setStatus(`Error: ${evt.message}`);
      finishAnalysis();
      break;
  }
}

function finishAnalysis() {
  state.analysisRunning = false;
  state.analysisMode    = null;
  showProgress(false);
  checkReady();
}

// ---------------------------------------------------------------------------
// Save analysis
// ---------------------------------------------------------------------------

function _showSaveRow() {
  const row   = document.getElementById('save-analysis-row');
  const input = document.getElementById('save-analysis-name');
  // Build a sensible default name
  const base = (state.kmlFile || state.csvFile || 'analysis')
    .replace(/\.[^.]+$/, '');
  const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  input.value = `${base} · ${date}`;
  row.classList.remove('hidden');
  input.focus();
  input.select();
}

async function saveAnalysis() {
  const name = document.getElementById('save-analysis-name').value.trim() || 'Unnamed';

  const payload = {
    name,
    kml_file:           state.kmlFile,
    csv_file:           state.csvFile,
    kml_coords:         state.kmlCoords,
    params:             state.lastAnalysisParams,
    receivers:          state.receivers,
    // Strip per-point rx_results (one entry per receiver per point) to keep
    // payload size manageable — they are only used for the hover signal panel
    // and terrain-profile receiver switcher, neither of which is critical for
    // a saved/restored view.
    path_results:       state.pathResults.map(pt => ({
      idx:         pt.idx,
      lat:         pt.lat,
      lon:         pt.lon,
      coverage:    pt.coverage,
      hard_fail:   pt.hard_fail,
      best_rx_idx: pt.best_rx_idx,
      best_rssi:   pt.best_rssi,
    })),
    inter_rx_results:   state.interRxResults,
    stats:              state.lastAnalysisStats    || [],
    total_coverage_pct: state.lastAnalysisTotalPct ?? null,
  };

  showTransferSpinner(`Saving "${name}"…`);
  try {
    const res  = await fetch('/api/analyses', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    document.getElementById('save-analysis-row').classList.add('hidden');
    setStatus(`Analysis saved as "${name}".`);
    fm.selAnalysis = data.id;
    _syncUrlForAnalysis(data.id);
    // Refresh analyses list in case file manager is open
    fm.analyses = await fetch('/api/analyses').then(r => r.json());
    renderFmSavedList();
  } catch (err) {
    setStatus(`Save failed: ${err.message}`);
  } finally {
    hideTransferSpinner();
  }
}

// ---------------------------------------------------------------------------
// Shareable links — a saved analysis's id round-trips through ?analysis=<id>
// ---------------------------------------------------------------------------

/** Absolute URL that reloads a given saved analysis (path only, no stray query params). */
function _analysisShareUrl(aid) {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('analysis', aid);
  return url.toString();
}

/** Reflect the loaded/saved analysis in the address bar without a page reload. */
function _syncUrlForAnalysis(aid) {
  history.replaceState(null, '', _analysisShareUrl(aid));
}

/** Clipboard write with a fallback for non-secure (plain http) deployments,
 *  where navigator.clipboard is unavailable. */
async function _copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity  = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Copy command was denied');
  } finally {
    document.body.removeChild(ta);
  }
}

// ---------------------------------------------------------------------------
// Replay helpers — redraw stored analysis results onto the map
// ---------------------------------------------------------------------------

/** Draw coverage track from stored pathResults. Fixes the stale-context
 *  segment-gap bug by maintaining segColor directly in the loop. */
function _drawPathResults(results) {
  resultLayer.clearLayers();
  if (!results || !results.length) return;

  const sorted = [...results].sort((a, b) => a.idx - b.idx);

  let segColor = null;
  let segPts   = [];

  const flush = nextPt => {
    if (segPts.length > 1) {
      const poly = L.polyline(segPts, { color: segColor, weight: 5, opacity: 0.85 });
      poly.on('click', e => {
        const nr = findNearestResult(rc(e.latlng.lat), rc(e.latlng.lng));
        if (nr && nr.best_rx_idx >= 0) showPathPointProfile(nr);
      });
      poly.addTo(resultLayer);
    }
    segPts = nextPt ? [nextPt] : [];
  };

  for (const pt of sorted) {
    const color  = pt.coverage   ? rxColor(pt.best_rx_idx)
                 : pt.hard_fail  ? '#ff5722'
                 :                 '#505060';
    const latlng = [pt.lat, pt.lon];
    if (color !== segColor) {
      flush(latlng);
      segColor = color;
    } else {
      segPts.push(latlng);
    }
  }
  flush(null);
}

/** Draw inter-receiver link lines from stored results. */
function _drawInterRxResults(results, receivers) {
  interRxLayer.clearLayers();
  if (!results || !results.length) return;

  for (const evt of results) {
    if (!evt.good_link) continue;
    const rx1 = receivers[evt.rx1_idx];
    const rx2 = receivers[evt.rx2_idx];
    if (!rx1 || !rx2) continue;
    if (!_rxEnabled(rx1) || !_rxEnabled(rx2)) continue;
    const r1 = _rxRole(rx1);
    const r2 = _rxRole(rx2);
    if (r1 === 'wide1' && r2 === 'wide1') continue;
    const isBackbone = (r1 === 'wide1' && (r2 === 'wide2' || r2 === 'igate'))
                    || (r2 === 'wide1' && (r1 === 'wide2' || r1 === 'igate'));
    const color  = isBackbone ? '#ffb300' : rxColor(evt.rx1_idx);
    const weight = isBackbone ? 3.5 : 2.5;
    const opts   = { color, weight, opacity: isBackbone ? 0.95 : 0.75,
                     rx1_idx: evt.rx1_idx, rx2_idx: evt.rx2_idx };
    if (isBackbone) opts.dashArray = '9 5';
    const roleDesc = r => (ROLE_LABEL[r] || r.toUpperCase());
    const rx1Name = escapeHtml(rx1.name), rx2Name = escapeHtml(rx2.name);
    const linkLabel = isBackbone
      ? `Backbone: ${rx1Name} (${roleDesc(r1)}) ↔ ${rx2Name} (${roleDesc(r2)})`
      : `${rx1Name} ↔ ${rx2Name}`;
    const pl = L.polyline(
      [[parseFloat(rx1.latitude), parseFloat(rx1.longitude)],
       [parseFloat(rx2.latitude), parseFloat(rx2.longitude)]],
      opts
    );
    pl.bindTooltip(
      `${linkLabel}<br>${evt.rssi} dBm · ${evt.dist_km} km · diff: ${evt.diff_db} dB`,
      { sticky: true }
    );
    pl.on('click', () => showTerrainProfile(rx1, rx2, evt.rx1_idx, evt.rx2_idx));
    pl.addTo(interRxLayer);
  }
}

// ---------------------------------------------------------------------------
// File manager — saved analyses tab
// ---------------------------------------------------------------------------

function renderFmSavedList() {
  const el = document.getElementById('fm-saved-list');
  if (!el) return;
  el.innerHTML = '';

  if (!fm.analyses.length) {
    el.innerHTML = '<div class="fm-empty">No saved analyses</div>';
    _setSavedBtns(false);
    return;
  }

  fm.analyses.forEach(a => {
    const div = document.createElement('div');
    div.className = 'fm-saved-item';
    if (a.id === fm.selAnalysis) div.classList.add('selected');

    const date = a.saved_at
      ? new Date(a.saved_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : '—';
    const modeBadge = a.mode
      ? `<span class="fm-saved-item-badge">${a.mode}</span>`
      : '';
    const covBadge  = a.total_coverage_pct != null
      ? `<span class="fm-saved-item-badge">${a.total_coverage_pct}% covered</span>`
      : '';

    div.innerHTML = `
      <div class="fm-saved-item-name">${escapeHtml(a.name || 'Unnamed')}</div>
      <div class="fm-saved-item-meta">
        <span>${date}</span>
        ${modeBadge}${covBadge}
        ${a.kml_file ? `<span class="fm-saved-item-badge">📍 ${escapeHtml(a.kml_file)}</span>` : ''}
        ${a.csv_file ? `<span class="fm-saved-item-badge">📋 ${escapeHtml(a.csv_file)}</span>` : ''}
      </div>`;
    div.addEventListener('click', () => {
      fm.selAnalysis = a.id;
      renderFmSavedList();
    });
    el.appendChild(div);
  });

  // Also covers selections made outside a click (e.g. fm.selAnalysis pre-set
  // from a ?analysis=<id> shared link before the modal was ever opened).
  _setSavedBtns(fm.analyses.some(a => a.id === fm.selAnalysis));
}

function _setSavedBtns(enabled) {
  document.getElementById('fm-saved-load-btn').disabled     = !enabled;
  document.getElementById('fm-saved-delete-btn').disabled   = !enabled;
  document.getElementById('fm-saved-copylink-btn').disabled = !enabled;
}

async function loadSavedAnalysis() {
  if (!fm.selAnalysis) return;
  if (await loadAnalysisById(fm.selAnalysis)) closeFmModal();
}

/** Fetch a saved analysis by id and restore it into the map/form/state.
 *  Shared by the "Load into Map" button and the ?analysis=<id> URL bootstrap. */
async function loadAnalysisById(aid) {
  showTransferSpinner('Loading analysis…');
  try {
    const res  = await fetch(`/api/analyses/${encodeURIComponent(aid)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // ── Restore RF form inputs ──────────────────────────────
    const p = data.params || {};
    if (p.freq_mhz        != null) document.getElementById('freq-select').value  = p.freq_mhz;
    if (p.tx_power_dbm    != null) {
      document.getElementById('tx-power').value = p.tx_power_dbm;
      document.getElementById('tx-power-w').textContent = fmtPower(p.tx_power_dbm);
    }
    if (p.tx_gain_dbi     != null) document.getElementById('tx-gain').value      = p.tx_gain_dbi;
    if (p.sensitivity_dbm != null) {
      document.getElementById('rx-sens').value = p.sensitivity_dbm;
      document.getElementById('rx-sens-uv').textContent = fmtUV(p.sensitivity_dbm);
    }
    if (p.veg_type        != null) document.getElementById('veg-loss').value     = p.veg_type;
    if (p.fade_margin_db  != null) document.getElementById('fade-margin').value  = p.fade_margin_db;
    if (p.chain_mode      != null) document.getElementById('chain-mode-toggle').checked = !!p.chain_mode;

    // ── Restore app state ───────────────────────────────────
    state.kmlFile            = data.kml_file || null;
    state.csvFile            = data.csv_file || null;
    state.kmlCoords          = data.kml_coords || [];
    state.lastFreqMhz        = p.freq_mhz || 915;
    state.receivers          = (data.receivers || []).map(r => {
      const rx = { enabled: '1', ...r };
      rx.role  = (rx.role || 'wide1').toLowerCase();   // legacy saves may have a blank role
      return rx;
    });
    state.pathResults        = data.path_results   || [];
    state.interRxResults     = data.inter_rx_results || [];
    state.lastAnalysisStats    = data.stats || [];
    state.lastAnalysisTotalPct = data.total_coverage_pct ?? null;
    state.lastAnalysisParams   = p;
    state.currentProfileData   = null;
    state.currentPathPoint     = null;
    state.currentProfileRxIdx  = -1;

    // ── Clear map layers ────────────────────────────────────
    pathLayer.clearLayers();
    rxLayer.clearLayers();
    resultLayer.clearLayers();
    interRxLayer.clearLayers();

    // ── Redraw map ──────────────────────────────────────────
    if (state.kmlCoords.length) {
      L.polyline(state.kmlCoords.map(([lat, lon]) => [lat, lon]),
        { color: '#888', weight: 3, opacity: 0.8 }).addTo(pathLayer);
    }
    drawReceivers(state.receivers);
    _drawPathResults(state.pathResults);
    _drawInterRxResults(state.interRxResults, state.receivers);

    // ── Fit map bounds ──────────────────────────────────────
    const allPts = [
      ...state.kmlCoords.map(([lat, lon]) => [lat, lon]),
      ...state.receivers.map(rx => [parseFloat(rx.latitude), parseFloat(rx.longitude)]),
    ].filter(([lat, lon]) => isFinite(lat) && isFinite(lon));
    if (allPts.length) map.fitBounds(L.latLngBounds(allPts).pad(0.1));

    // ── Restore results table ───────────────────────────────
    if (state.lastAnalysisStats.length) {
      renderResults(state.lastAnalysisStats, state.lastAnalysisTotalPct);
    } else {
      hideResults();
    }

    // ── Reset profile panel ─────────────────────────────────
    document.getElementById('profile-canvas').style.display = 'none';
    document.getElementById('profile-empty').style.display  = '';
    document.getElementById('profile-empty').textContent    = 'Click the path or an inter-receiver link to view terrain profile';
    document.getElementById('profile-link-label').classList.add('hidden');
    document.getElementById('profile-rx-sidebar').classList.add('hidden');
    document.getElementById('map-signal-panel').classList.add('hidden');
    document.getElementById('save-analysis-row').classList.add('hidden');

    updateSidebarBtns();
    checkReady();
    // single-rx-select's options are rebuilt by checkReady() -> updateSingleRxSelect(),
    // so the focused receiver can only be restored after that call.
    if (p.single_rx) document.getElementById('single-rx-select').value = p.single_rx;

    fm.selAnalysis = aid;
    _syncUrlForAnalysis(aid);
    setStatus(`Loaded "${data.name || 'analysis'}".`);
    return true;
  } catch (err) {
    alert(`Load failed: ${err.message}`);
    return false;
  } finally {
    hideTransferSpinner();
  }
}

async function deleteSavedAnalysis() {
  if (!fm.selAnalysis) return;
  const item = fm.analyses.find(a => a.id === fm.selAnalysis);
  if (!confirm(`Delete "${item?.name || 'this analysis'}"?`)) return;
  await fetch(`/api/analyses/${encodeURIComponent(fm.selAnalysis)}`, { method: 'DELETE' });
  fm.selAnalysis = null;
  _setSavedBtns(false);
  fm.analyses = await fetch('/api/analyses').then(r => r.json());
  renderFmSavedList();
}

// ---------------------------------------------------------------------------
// Results table (bottom bar — coverage tab)
// ---------------------------------------------------------------------------

function hideResults() {
  document.getElementById('results-empty').classList.remove('hidden');
  document.getElementById('results-scroll').classList.add('hidden');
}

function renderResults(stats, totalPct, doSwitchTab = true, trackDistM = 0) {
  const tbody = document.getElementById('results-tbody');
  const tfoot = document.getElementById('results-tfoot');
  tbody.innerHTML = '';
  tfoot.innerHTML = '';

  stats.forEach((s, i) => {
    const color   = rxColor(s.color_idx ?? i);
    const distM   = trackDistM > 0 ? Math.round(trackDistM * s.coverage_pct / 100) : null;
    const distMi  = distM !== null ? (distM * 0.000621371).toFixed(2) : null;
    const tr      = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="rx-swatch" style="background:${color}"></span>${escapeHtml(s.name)}</td>
      <td>${s.coverage_pct}%</td>
      <td>${s.avg_rssi !== null ? s.avg_rssi + ' dBm' : '—'}</td>
      <td>${distM !== null ? distM.toLocaleString() : '—'}</td>
      <td>${distMi !== null ? distMi : '—'}</td>`;
    tbody.appendChild(tr);
  });

  const totalDistM  = trackDistM > 0 ? Math.round(trackDistM * totalPct / 100) : null;
  const totalDistMi = totalDistM !== null ? (totalDistM * 0.000621371).toFixed(2) : null;
  const tf = document.createElement('tr');
  tf.innerHTML = `<td>Total Course Coverage</td><td>${totalPct}%</td><td>—</td>
    <td>${totalDistM !== null ? totalDistM.toLocaleString() : '—'}</td>
    <td>${totalDistMi !== null ? totalDistMi : '—'}</td>`;
  tfoot.appendChild(tf);

  document.getElementById('results-empty').classList.add('hidden');
  document.getElementById('results-scroll').classList.remove('hidden');
  if (doSwitchTab) switchTab('coverage');
}

// ---------------------------------------------------------------------------
// Terrain profile (bottom bar — profile tab)
// ---------------------------------------------------------------------------

state.currentProfileData = null;

function fspl_db(freqMhz, distM) {
  return 32.44 + 20 * Math.log10(freqMhz) + 20 * Math.log10(Math.max(distM, 1) / 1000);
}

async function showTerrainProfile(rx1, rx2, rx1Idx = 0, rx2Idx = 1) {
  switchTab('profile');
  const canvas   = document.getElementById('profile-canvas');
  const emptyEl  = document.getElementById('profile-empty');
  const labelEl  = document.getElementById('profile-link-label');
  const sidebar  = document.getElementById('profile-rx-sidebar');

  // Inter-receiver link view — hide the path-point receiver sidebar
  sidebar.classList.add('hidden');
  state.currentPathPoint     = null;
  state.currentProfileRxIdx  = -1;
  state.currentProfileRx1Idx = rx1Idx;
  state.currentProfileRx2Idx = rx2Idx;

  canvas.style.display  = 'none';
  emptyEl.style.display = '';
  emptyEl.textContent   = 'Loading terrain profile…';

  try {
    const p = new URLSearchParams({
      lat1:     rx1.latitude,  lon1: rx1.longitude,
      h1:       rx1.height_agl_m || 2,
      lat2:     rx2.latitude,  lon2: rx2.longitude,
      h2:       rx2.height_agl_m || 2,
      freq_mhz: state.lastFreqMhz,
      veg_type: document.getElementById('veg-loss').value,
    });
    const res  = await fetch(`/api/profile?${p}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Attach display metadata consumed by drawProfile
    data._rx1Color = rxColor(rx1Idx);
    data._rx2Color = rxColor(rx2Idx);
    data._rx1Name  = rx1.name || `RX${rx1Idx + 1}`;
    data._rx2Name  = rx2.name || `RX${rx2Idx + 1}`;
    const txPow  = parseFloat(rx1.tx_power_dbm)     || 22;
    const txGain = parseFloat(rx1.antenna_gain_dbi) || 0;
    const rxGain = parseFloat(rx2.antenna_gain_dbi) || 0;
    const vegLoss = data.veg_loss_db || 0;   // server-computed from actual path profile
    const fsplVal = fspl_db(state.lastFreqMhz, data.dist_m);
    const fadeMargin = parseFloat(document.getElementById('fade-margin').value) || 0;
    data._txPow       = txPow;
    data._txGain      = txGain;
    data._rxGain      = rxGain;
    data._vegLoss     = vegLoss;
    data._fspl        = fsplVal;
    data._freqMhz     = state.lastFreqMhz;
    data._fadeMargin  = fadeMargin;
    data._rssi        = Math.round((txPow + txGain + rxGain - fsplVal - data.diff_db - vegLoss) * 10) / 10;
    data._sensitivity = parseFloat(document.getElementById('rx-sens').value) || -135;

    state.currentProfileData = data;
    emptyEl.style.display  = 'none';
    canvas.style.display   = 'block';

    labelEl.textContent = `${data._rx1Name} ↔ ${data._rx2Name}  ·  ${(data.dist_m / 1000).toFixed(2)} km  ·  ${data._rssi} dBm`;
    labelEl.classList.remove('hidden');

    drawProfile(data, canvas);
  } catch (err) {
    emptyEl.textContent = `Error: ${err.message}`;
    canvas.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Path-point → best-receiver terrain profile
// ---------------------------------------------------------------------------

async function showPathPointProfile(pt, forceRxIdx = null) {
  // Determine which receiver to profile: forceRxIdx overrides best_rx_idx
  // Fall back to the first covered receiver if best is -1
  let rxIdx = forceRxIdx !== null ? forceRxIdx : pt.best_rx_idx;
  // If no best (uncovered point) and no forceRxIdx, pick first available rx_results entry
  if (rxIdx < 0 && pt.rx_results?.length) rxIdx = pt.rx_results[0].rx_idx ?? 0;
  const rx = state.receivers[rxIdx];
  if (!rx) return;

  // Persist current point + rx so sidebar can re-render on switch
  state.currentPathPoint     = pt;
  state.currentProfileRxIdx  = rxIdx;
  state.currentProfileRx1Idx = -1;
  state.currentProfileRx2Idx = -1;

  switchTab('profile');
  const canvas  = document.getElementById('profile-canvas');
  const emptyEl = document.getElementById('profile-empty');
  const labelEl = document.getElementById('profile-link-label');

  canvas.style.display  = 'none';
  emptyEl.style.display = '';
  emptyEl.textContent   = 'Loading terrain profile…';

  // Render sidebar immediately so user sees receiver list while profile loads
  _renderProfileSidebar(pt, rxIdx);

  try {
    const p = new URLSearchParams({
      lat1:     pt.lat,            lon1: pt.lon,
      h1:       1.5,               // tracker height AGL matches TRACKER_H on server
      lat2:     rx.latitude,       lon2: rx.longitude,
      h2:       rx.height_agl_m || 2,
      freq_mhz: state.lastFreqMhz,
      veg_type: document.getElementById('veg-loss').value,
    });
    const res  = await fetch(`/api/profile?${p}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const txPow     = parseFloat(document.getElementById('tx-power').value) || 22;
    const txGain    = parseFloat(document.getElementById('tx-gain').value)  || 0;
    const rxGain    = parseFloat(rx.antenna_gain_dbi) || 0;
    const vegLoss   = data.veg_loss_db || 0;   // server-computed from actual path profile
    const fadeMargin = parseFloat(document.getElementById('fade-margin').value) || 0;

    const fsplVal = fspl_db(state.lastFreqMhz, data.dist_m);
    data._rx1Color    = '#aaaaaa';
    data._rx2Color    = rxColor(rxIdx);
    data._rx1Name     = 'Tracker';
    data._rx2Name     = rx.name || `RX${rxIdx + 1}`;
    data._txPow       = txPow;
    data._txGain      = txGain;
    data._rxGain      = rxGain;
    data._vegLoss     = vegLoss;
    data._fspl        = fsplVal;
    data._freqMhz     = state.lastFreqMhz;
    data._fadeMargin  = fadeMargin;
    data._rssi        = Math.round((txPow + txGain + rxGain - fsplVal - data.diff_db - vegLoss) * 10) / 10;
    data._sensitivity = parseFloat(document.getElementById('rx-sens').value) || -135;

    state.currentProfileData = data;
    emptyEl.style.display = 'none';
    canvas.style.display  = 'block';

    labelEl.textContent = `Tracker → ${data._rx2Name}  ·  ${(data.dist_m / 1000).toFixed(2)} km  ·  ${data._rssi} dBm`;
    labelEl.classList.remove('hidden');

    drawProfile(data, canvas);
  } catch (err) {
    emptyEl.textContent = `Error: ${err.message}`;
    canvas.style.display = 'none';
  }
}

function _renderProfileSidebar(pt, activeRxIdx) {
  const sidebar = document.getElementById('profile-rx-sidebar');
  if (!pt?.rx_results?.length) {
    sidebar.classList.add('hidden');
    return;
  }

  let html = `<div class="profile-rx-sidebar-title">Receivers</div>`;
  for (const rr of pt.rx_results) {
    const idx   = rr.rx_idx ?? -1;
    const rx    = idx >= 0 ? state.receivers[idx] : null;
    const name  = rx?.name || (idx >= 0 ? `RX${idx + 1}` : 'RX?');
    const color = idx >= 0 ? rxColor(idx) : '#888';
    const sensitivity = parseFloat(document.getElementById('rx-sens').value) || -135;
    const fadeMargin  = parseFloat(document.getElementById('fade-margin').value) || 0;
    const covered     = !rr.hard_fail && rr.rssi >= sensitivity + fadeMargin;
    const rssiColor   = covered ? color : 'var(--text-dim)';
    const isActive    = idx === activeRxIdx;

    html += `<div class="profile-rx-item${isActive ? ' active' : ''}" data-rx-idx="${idx}">
      <span class="profile-rx-dot" style="background:${color}"></span>
      <div class="profile-rx-label">
        <span class="profile-rx-name">${name}</span>
        <span class="profile-rx-rssi" style="color:${rssiColor}">${rr.rssi} dBm</span>
      </div>
    </div>`;
  }

  sidebar.innerHTML = html;
  sidebar.classList.remove('hidden');

  // Wire clicks to switch the profiled receiver
  sidebar.querySelectorAll('.profile-rx-item').forEach(item => {
    item.addEventListener('click', () => {
      const newRxIdx = parseInt(item.dataset.rxIdx, 10);
      if (newRxIdx !== state.currentProfileRxIdx && state.currentPathPoint) {
        showPathPointProfile(state.currentPathPoint, newRxIdx);
      }
    });
  });
}

// Redraw on resize
new ResizeObserver(() => {
  if (state.currentProfileData) {
    const c = document.getElementById('profile-canvas');
    if (c.style.display !== 'none') drawProfile(state.currentProfileData, c);
  }
}).observe(document.getElementById('tab-profile'));

// ---------------------------------------------------------------------------
// Profile canvas drawing
// ---------------------------------------------------------------------------

function drawProfile(data, canvas) {
  const parent  = canvas.parentElement;
  const sidebar = document.getElementById('profile-rx-sidebar');
  const sidebarW = (sidebar && !sidebar.classList.contains('hidden')) ? sidebar.offsetWidth : 0;
  const W = parent.clientWidth - sidebarW;
  const H = parent.clientHeight;
  if (W < 1 || H < 1) return;

  const DPR = window.devicePixelRatio || 1;
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  const BUDGET_W = 152;   // link budget box width (px)
  const PAD  = { top: 22, right: BUDGET_W + 24, bottom: 38, left: 58 };
  const CW   = W - PAD.left - PAD.right;
  const CH   = H - PAD.top  - PAD.bottom;
  const pts  = data.points;
  const dist = data.dist_m;

  if (!pts.length || dist < 1 || CW < 10 || CH < 10) return;

  // ── Elevation range ──────────────────────────────────────
  // min anchored to lowest terrain point − 10 % padding so variation is visible
  const terrainE = pts.map(p => p.eff_m).filter(Number.isFinite);
  const allE     = pts.flatMap(p => [p.eff_m, p.los_m, p.los_m + p.f1r_m * 0.6]).filter(Number.isFinite);
  const rawMin   = Math.min(...terrainE);
  const rawMax   = Math.max(...allE);
  const eRange   = rawMax - rawMin || 10;
  const minE     = rawMin - eRange * 0.10;
  const maxE     = rawMax + eRange * 0.10;

  const xS = d => PAD.left + (d / dist) * CW;
  const yS = e => PAD.top  + CH - ((e - minE) / (maxE - minE)) * CH;

  // ── Background ───────────────────────────────────────────
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#12151f';
  ctx.fillRect(PAD.left, PAD.top, CW, CH);

  // ── Grid lines ───────────────────────────────────────────
  const NY = 4;
  ctx.strokeStyle = '#1e2235'; ctx.lineWidth = 1; ctx.setLineDash([]);
  for (let i = 0; i <= NY; i++) {
    const y = yS(minE + (maxE - minE) * i / NY);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + CW, y); ctx.stroke();
  }
  const NX = Math.min(8, Math.max(3, Math.floor(CW / 80)));
  for (let i = 0; i <= NX; i++) {
    const x = xS(dist * i / NX);
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + CH); ctx.stroke();
  }

  // ── Fresnel zone fills ────────────────────────────────────
  // Full F1 — very faint tint
  ctx.beginPath();
  pts.forEach((p, i) => {
    i === 0 ? ctx.moveTo(xS(p.d_m), yS(p.los_m + p.f1r_m))
            : ctx.lineTo(xS(p.d_m), yS(p.los_m + p.f1r_m));
  });
  [...pts].reverse().forEach(p => ctx.lineTo(xS(p.d_m), yS(p.los_m - p.f1r_m)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,240,80,0.04)'; ctx.fill();

  // 60 % zone — slightly brighter fill
  ctx.beginPath();
  pts.forEach((p, i) => {
    const r = p.f1r_m * 0.6;
    i === 0 ? ctx.moveTo(xS(p.d_m), yS(p.los_m + r))
            : ctx.lineTo(xS(p.d_m), yS(p.los_m + r));
  });
  [...pts].reverse().forEach(p => ctx.lineTo(xS(p.d_m), yS(p.los_m - p.f1r_m * 0.6)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,240,80,0.09)'; ctx.fill();

  // ── Fresnel zone boundary lines ───────────────────────────
  const _fresnelLine = (radiusFn, dash, color, lw) => {
    for (const sign of [1, -1]) {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const y = yS(p.los_m + sign * radiusFn(p));
        i === 0 ? ctx.moveTo(xS(p.d_m), y) : ctx.lineTo(xS(p.d_m), y);
      });
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash(dash);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  };
  _fresnelLine(p => p.f1r_m,       [5, 4], 'rgba(255,240,80,0.50)', 1);    // F1 boundary
  _fresnelLine(p => p.f1r_m * 0.6, [3, 3], 'rgba(255,240,80,0.28)', 0.75); // 60% boundary

  // Labels at right edge of chart
  const _lastP = pts[pts.length - 1];
  ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,240,80,0.55)';
  ctx.fillText('F₁', xS(_lastP.d_m) - 3, yS(_lastP.los_m + _lastP.f1r_m) - 3);
  ctx.fillStyle = 'rgba(255,240,80,0.35)';
  ctx.fillText('60%', xS(_lastP.d_m) - 3, yS(_lastP.los_m + _lastP.f1r_m * 0.6) - 3);

  // ── Terrain fill ─────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(xS(0), yS(minE));
  pts.forEach(p => ctx.lineTo(xS(p.d_m), yS(p.eff_m)));
  ctx.lineTo(xS(dist), yS(minE));
  ctx.closePath();
  const tg = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + CH);
  tg.addColorStop(0, 'rgba(110,80,40,0.92)');
  tg.addColorStop(1, 'rgba(40,28,12,0.90)');
  ctx.fillStyle = tg; ctx.fill();

  // ── Terrain outline ──────────────────────────────────────
  ctx.beginPath();
  pts.forEach((p, i) => {
    i === 0 ? ctx.moveTo(xS(p.d_m), yS(p.eff_m))
            : ctx.lineTo(xS(p.d_m), yS(p.eff_m));
  });
  ctx.strokeStyle = '#c8a86a'; ctx.lineWidth = 1.5; ctx.setLineDash([]); ctx.stroke();

  // ── Blocked segments (terrain above LOS) ─────────────────
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    if (p0.clr_m < 0 || p1.clr_m < 0) {
      const x0    = xS(p0.d_m), x1 = xS(p1.d_m);
      const yTop  = Math.min(yS(p0.eff_m), yS(p1.eff_m));
      const yBot  = Math.max(yS(p0.los_m), yS(p1.los_m));
      const hRect = Math.max(1, yBot - yTop);
      ctx.fillStyle = 'rgba(230,57,70,0.38)';
      ctx.fillRect(x0, yTop, x1 - x0, hRect);
    }
  }

  // ── LOS line ─────────────────────────────────────────────
  ctx.beginPath();
  pts.forEach((p, i) => {
    i === 0 ? ctx.moveTo(xS(p.d_m), yS(p.los_m))
            : ctx.lineTo(xS(p.d_m), yS(p.los_m));
  });
  ctx.strokeStyle = 'rgba(255,255,255,0.80)';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([8, 5]);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Diffraction ray + obstacle markers ───────────────────
  const obstacles = data.obstacles || [];
  const domObs    = obstacles.find(o => o.level === 0);

  if (domObs) {
    // Bent diffraction ray: TX → dominant obstacle tip → RX
    // Drawn as two amber line segments meeting at the knife-edge point.
    ctx.beginPath();
    ctx.moveTo(xS(0),        yS(data.from_total_m));
    ctx.lineTo(xS(domObs.d_m), yS(domObs.eff_m));
    ctx.lineTo(xS(dist),     yS(data.to_total_m));
    ctx.strokeStyle = 'rgba(255, 165, 0, 0.72)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    ctx.stroke();
  }

  // Obstacle markers — dominant first, then secondaries
  const obsOrder = [
    ...obstacles.filter(o => o.level === 1),  // secondaries behind
    ...obstacles.filter(o => o.level === 0),  // dominant on top
  ];
  for (const obs of obsOrder) {
    const ox      = xS(obs.d_m);
    const oy      = yS(obs.eff_m);
    const isMain  = obs.level === 0;
    const baseClr = isMain ? 'rgba(255,165,0,0.88)' : 'rgba(255,165,0,0.50)';

    // Vertical dashed drop-line from terrain tip to chart baseline
    ctx.beginPath();
    ctx.moveTo(ox, PAD.top + CH);
    ctx.lineTo(ox, oy);
    ctx.strokeStyle = baseClr;
    ctx.lineWidth   = isMain ? 1 : 0.75;
    ctx.setLineDash(isMain ? [3, 2] : [2, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Diamond marker at the knife-edge tip
    const ds = isMain ? 5 : 3;
    ctx.beginPath();
    ctx.moveTo(ox,      oy - ds);
    ctx.lineTo(ox + ds, oy);
    ctx.lineTo(ox,      oy + ds);
    ctx.lineTo(ox - ds, oy);
    ctx.closePath();
    ctx.fillStyle = baseClr;
    ctx.fill();

    // Loss annotation above the marker
    if (isMain) {
      const lbl = `−${obs.loss_db} dB`;
      ctx.font      = 'bold 9px sans-serif';
      const tw      = ctx.measureText(lbl).width;
      // Small backing pill so the text is legible over terrain
      ctx.fillStyle = 'rgba(13,15,22,0.75)';
      ctx.fillRect(ox - tw / 2 - 3, oy - ds - 15, tw + 6, 12);
      ctx.fillStyle = 'rgba(255,165,0,0.95)';
      ctx.textAlign = 'center';
      ctx.fillText(lbl, ox, oy - ds - 5);
    } else {
      // Secondary: smaller label, shifted to avoid overlap with dominant
      const side = obs.d_m < domObs?.d_m ? -1 : 1;
      ctx.font      = '9px sans-serif';
      ctx.fillStyle = 'rgba(255,165,0,0.60)';
      ctx.textAlign = side < 0 ? 'right' : 'left';
      ctx.fillText(`−${obs.loss_db} dB`, ox + side * 6, oy - ds - 4);
    }
  }

  // ── Endpoint markers (colored by receiver) ───────────────
  const endpoints = [
    { d: 0,    elev: data.from_total_m, color: data._rx1Color || '#4f8ef7',
      name: data._rx1Name || 'RX1', align: 'left',  nx:  8 },
    { d: dist, elev: data.to_total_m,   color: data._rx2Color || '#4f8ef7',
      name: data._rx2Name || 'RX2', align: 'right', nx: -8 },
  ];
  endpoints.forEach(ep => {
    const x = xS(ep.d);
    const y = yS(ep.elev);
    ctx.fillStyle   = ep.color;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = ep.color;
    ctx.font      = 'bold 10px sans-serif';
    ctx.textAlign = ep.align;
    ctx.fillText(ep.name, x + ep.nx, y - 8);
  });

  // ── Y-axis labels (elevation) ────────────────────────────
  ctx.fillStyle = '#7a82a0'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let i = 0; i <= NY; i++) {
    const e = minE + (maxE - minE) * i / NY;
    ctx.fillText(`${Math.round(e)} m`, PAD.left - 5, yS(e) + 3);
  }

  // ── X-axis labels (distance) ─────────────────────────────
  ctx.textAlign = 'center';
  for (let i = 0; i <= NX; i++) {
    const d  = dist * i / NX;
    const km = (d / 1000).toFixed(d >= 10000 ? 0 : 1);
    ctx.fillText(`${km} km`, xS(d), PAD.top + CH + 14);
  }

  // ── Axis borders ─────────────────────────────────────────
  ctx.strokeStyle = '#2e3350'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.left, PAD.top);
  ctx.lineTo(PAD.left, PAD.top + CH);
  ctx.lineTo(PAD.left + CW, PAD.top + CH);
  ctx.stroke();

  // ── RSSI label centred on LOS line ───────────────────────
  if (data._rssi !== undefined) {
    const midIdx   = Math.floor(pts.length / 2);
    const mx       = xS(pts[midIdx].d_m);
    const my       = yS(pts[midIdx].los_m);
    const rssiTxt  = `${data._rssi} dBm`;
    const threshold = (data._sensitivity || -135) + (data._fadeMargin || 0);
    const passColor = data._rssi >= threshold ? '#4caf7d' : '#e05252';
    ctx.font = 'bold 11px sans-serif';
    const tw = ctx.measureText(rssiTxt).width;
    ctx.fillStyle = 'rgba(15,17,23,0.80)';
    ctx.fillRect(mx - tw / 2 - 5, my - 10, tw + 10, 16);
    ctx.fillStyle = passColor;
    ctx.textAlign = 'center';
    ctx.fillText(rssiTxt, mx, my + 3);
  }

  // ── Link budget breakdown (right-side panel) ─────────────
  if (data._txPow !== undefined) {
    const sgn = v => (v >= 0 ? '+' : '') + v.toFixed(1);
    const vegLoss    = data._vegLoss   || 0;
    const fadeMargin = data._fadeMargin || 0;
    const threshold  = (data._sensitivity || -135) + fadeMargin;
    const aboveFloor = data._rssi >= threshold;
    const hardFail   = data.diff_db >= 30 || vegLoss >= 30;
    const rows = [
      { label: `${data._freqMhz} MHz  ·  ${(data.dist_m/1000).toFixed(2)} km`,
        value: null, color: '#7a82a0', italic: true },
      { sep: true },
      { label: 'Tx Power',    value: `${sgn(data._txPow)} dBm`,          color: '#dde1f0' },
      { label: 'Tx Gain',     value: `${sgn(data._txGain)} dBi`,         color: '#dde1f0' },
      { label: 'Rx Gain',     value: `${sgn(data._rxGain)} dBi`,         color: '#dde1f0' },
      { label: 'Path Loss',   value: `−${data._fspl.toFixed(1)} dB`,     color: '#e07070' },
      { label: 'Diffraction', value: data.diff_db > 0
                                       ? `−${data.diff_db.toFixed(1)} dB`
                                       : '0.0 dB',
        color: data.diff_db >= 30 ? '#e05252' : data.diff_db > 0 ? '#e09050' : '#7a82a0' },
      { label: 'Vegetation',  value: vegLoss > 0
                                       ? `−${vegLoss.toFixed(1)} dB`
                                       : '0.0 dB',
        color: vegLoss >= 30 ? '#e05252' : vegLoss > 0 ? '#e09050' : '#7a82a0' },
      { sep: true },
      { label: 'RSSI',        value: `${data._rssi} dBm`,
        color: hardFail ? '#e05252' : aboveFloor ? '#4caf7d' : '#e09050', bold: true },
      { label: `Sensitivity + ${fadeMargin} dB fade`,
        value: `${threshold} dBm`, color: '#7a82a0' },
    ];

    const LH = 13, BW = BUDGET_W, BP = 6;
    const sepCount = rows.filter(r => r.sep).length;
    const BH = (rows.length - sepCount) * LH + sepCount * 6 + BP * 2;
    // Position box in the right margin, vertically centred in the chart
    const bX = PAD.left + CW + 12;
    const bY = PAD.top + Math.max(0, (CH - BH) / 2);

    ctx.fillStyle = 'rgba(13,15,22,0.86)';
    ctx.beginPath();
    ctx.roundRect(bX, bY, BW, BH, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(46,51,80,0.9)'; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.roundRect(bX, bY, BW, BH, 4); ctx.stroke();

    let ry = bY + BP + LH - 3;
    for (const row of rows) {
      if (row.sep) {
        ctx.strokeStyle = 'rgba(46,51,80,0.8)'; ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(bX + 4, ry - LH * 0.3);
        ctx.lineTo(bX + BW - 4, ry - LH * 0.3);
        ctx.stroke();
        ry += 6; continue;
      }
      ctx.fillStyle = row.color;
      ctx.font = (row.bold ? 'bold ' : '') + (row.italic ? 'italic ' : '') + '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(row.label, bX + BP, ry);
      if (row.value !== null) {
        ctx.textAlign = 'right';
        ctx.fillText(row.value, bX + BW - BP, ry);
      }
      ry += LH;
    }
  }
}

// ---------------------------------------------------------------------------
// Add Receiver dialog
// ---------------------------------------------------------------------------

document.getElementById('add-rx-btn').addEventListener('click', () => {
  const center = map.getCenter();
  const n      = state.receivers.length + 1;
  document.getElementById('add-rx-name').value   = `RX${n}`;
  document.getElementById('add-rx-lat').value    = center.lat.toFixed(6);
  document.getElementById('add-rx-lon').value    = center.lng.toFixed(6);
  document.getElementById('add-rx-height').value = '2';
  document.getElementById('add-rx-gain').value   = '5.8';
  document.getElementById('add-rx-power').value  = '28';
  document.getElementById('add-rx-modal').classList.remove('hidden');
  // Select the name so user can type immediately
  setTimeout(() => document.getElementById('add-rx-name').select(), 30);
});

function closeAddRxModal() {
  document.getElementById('add-rx-modal').classList.add('hidden');
}
document.getElementById('add-rx-modal-close').addEventListener('click', closeAddRxModal);
document.getElementById('add-rx-cancel').addEventListener('click',      closeAddRxModal);
document.getElementById('add-rx-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('add-rx-modal')) closeAddRxModal();
});

document.getElementById('add-rx-confirm').addEventListener('click', async () => {
  const lat = parseFloat(document.getElementById('add-rx-lat').value);
  const lon = parseFloat(document.getElementById('add-rx-lon').value);
  if (isNaN(lat) || isNaN(lon)) { alert('Enter valid coordinates.'); return; }

  const newRx = {
    name:             document.getElementById('add-rx-name').value.trim()
                        || `RX${state.receivers.length + 1}`,
    latitude:         lat.toFixed(6),
    longitude:        lon.toFixed(6),
    height_agl_m:     document.getElementById('add-rx-height').value || '5',
    antenna_gain_dbi: document.getElementById('add-rx-gain').value   || '0',
    tx_power_dbm:     document.getElementById('add-rx-power').value  || '22',
    role:             document.getElementById('add-rx-role').value   || 'wide1',
    enabled:          document.getElementById('add-rx-enabled').checked ? '1' : '0',
  };

  const idx = state.receivers.length;   // index before push
  state.receivers.push(newRx);
  _addRxMarker(newRx, idx);             // add marker without refitting bounds
  checkReady();
  closeAddRxModal();

  showTransferSpinner(`Saving ${newRx.name}…`);
  if (state.csvFile) {
    try {
      const res  = await fetch(`/api/csv/${encodeURIComponent(state.csvFile)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ rows: state.receivers }),
      });
      const data = await res.json();
      if (data.ok) {
        // Keep file manager editor in sync, but only if it's showing this file
        if (fm.editorFile === state.csvFile) {
          fm.editorRows = state.receivers.map(r => ({ ...r }));
          renderFmEditorTable();
        }
        setStatus(`Added ${newRx.name} and saved to ${state.csvFile}.`);
      } else {
        setStatus(`Added ${newRx.name} — save failed, check server logs.`);
      }
    } catch (err) {
      setStatus(`Added ${newRx.name} — save error: ${err.message}`);
    } finally {
      hideTransferSpinner();
    }
  } else {
    // No CSV loaded — auto-create one on the server
    try {
      const lines = [CSV_COLS.join(',')];
      state.receivers.forEach(row => {
        lines.push(CSV_COLS.map(c => {
          const v = String(row[c] ?? '');
          return v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(','));
      });
      const ts       = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const filename = `receivers-${ts}.csv`;
      const blob     = new Blob([lines.join('\n')], { type: 'text/csv' });
      const fd       = new FormData();
      fd.append('file', new File([blob], filename, { type: 'text/csv' }));
      const res  = await fetch('/api/upload/csv', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.filename) {
        state.csvFile  = data.filename;
        // Prime the file manager so it reflects the new file immediately
        fm.editorFile  = data.filename;
        fm.editorRows  = state.receivers.map(r => ({ ...r }));
        fm.selCsv      = data.filename;
        await refreshFmFileLists();
        updateSidebarBtns();
        checkReady();
        setStatus(`Added ${newRx.name} and created ${data.filename}.`);
      } else {
        setStatus(`Added ${newRx.name} — CSV create failed: ${data.error || 'unknown error'}`);
      }
    } catch (err) {
      setStatus(`Added ${newRx.name} — CSV create error: ${err.message}`);
    } finally {
      hideTransferSpinner();
    }
  }
});

// ---------------------------------------------------------------------------
// File manager — event listeners
// ---------------------------------------------------------------------------

document.getElementById('kml-mgr-btn').addEventListener('click', () => openFileManager('kml'));
document.getElementById('csv-mgr-btn').addEventListener('click', () => openFileManager('csv'));

document.querySelectorAll('.fm-tab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchFmTab(btn.dataset.fmTab)));

document.getElementById('fm-modal-close').addEventListener('click', closeFmModal);
document.getElementById('fm-close-kml').addEventListener('click',   closeFmModal);
document.getElementById('fm-close-csv').addEventListener('click',   closeFmModal);
document.getElementById('file-mgr-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('file-mgr-modal')) closeFmModal();
});

// KML tab
document.getElementById('fm-kml-upload').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  showTransferSpinner(`Uploading ${file.name}…`);
  try {
    const res  = await fetch('/api/upload/kml', { method: 'POST', body: fd });
    const data = await res.json();
    e.target.value = '';
    if (data.error) { alert(data.error); return; }
    await refreshFmFileLists();
    await selectFmFile('kml', data.filename);
  } finally {
    hideTransferSpinner();
  }
});

document.getElementById('fm-kml-load-btn').addEventListener('click',   loadFmKml);
document.getElementById('fm-kml-download-btn').addEventListener('click', () => {
  if (!fm.selKml) return;
  const a = document.createElement('a');
  a.href     = `/api/files/kml/${encodeURIComponent(fm.selKml)}`;
  a.download = fm.selKml;
  a.click();
});
document.getElementById('fm-kml-rename-btn').addEventListener('click', () => renameFmFile('kml'));
document.getElementById('fm-kml-delete-btn').addEventListener('click', () => deleteFmFile('kml'));

// CSV tab
document.getElementById('fm-csv-upload').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  showTransferSpinner(`Uploading ${file.name}…`);
  try {
    const res  = await fetch('/api/upload/csv', { method: 'POST', body: fd });
    const data = await res.json();
    e.target.value = '';
    if (data.error) { alert(data.error); return; }
    await refreshFmFileLists();
    await selectFmFile('csv', data.filename);
  } finally {
    hideTransferSpinner();
  }
});

document.getElementById('fm-csv-load-btn').addEventListener('click',     loadFmCsv);
document.getElementById('fm-save-csv-btn').addEventListener('click',     saveFmCsv);
document.getElementById('fm-download-csv-btn').addEventListener('click', downloadFmCsv);
document.getElementById('fm-csv-rename-btn').addEventListener('click',   () => renameFmFile('csv'));
document.getElementById('fm-csv-delete-btn').addEventListener('click',   () => deleteFmFile('csv'));

document.getElementById('fm-add-row-btn').addEventListener('click', () => {
  const row = {}; CSV_COLS.forEach(c => { row[c] = ''; });
  fm.editorRows.push(row);
  renderFmEditorTable();
  document.getElementById('fm-editor-wrap').querySelector('.table-scroll').scrollTop = 99999;
});

// Saved analyses tab
document.getElementById('saved-mgr-btn').addEventListener('click',      () => openFileManager('saved'));
document.getElementById('fm-saved-load-btn').addEventListener('click',  loadSavedAnalysis);
document.getElementById('fm-saved-delete-btn').addEventListener('click', deleteSavedAnalysis);
document.getElementById('fm-close-saved').addEventListener('click',     closeFmModal);
document.getElementById('fm-saved-copylink-btn').addEventListener('click', async () => {
  if (!fm.selAnalysis) return;
  try {
    await _copyToClipboard(_analysisShareUrl(fm.selAnalysis));
    setStatus('Link copied to clipboard.');
  } catch (err) {
    setStatus(`Copy failed: ${err.message}`);
  }
});

// Save-analysis row (shown after a successful analysis)
document.getElementById('save-analysis-btn').addEventListener('click',  saveAnalysis);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

refreshFmFileLists();

// A ?analysis=<id> query param (a shared link) loads that saved analysis
// automatically instead of requiring the user to open "Saved Analyses" and
// pick it manually.
const _sharedAnalysisId = new URLSearchParams(window.location.search).get('analysis');
if (_sharedAnalysisId) {
  fm.selAnalysis = _sharedAnalysisId;
  loadAnalysisById(_sharedAnalysisId);
}

// ---------------------------------------------------------------------------
// Infrastructure Location Advisor
// ---------------------------------------------------------------------------

// Extend state for the advisor
state.iaRunning          = false;
state.iaAbortCtrl        = null;
state.iaSuggestions      = [];
state.iaSelectedIdx      = -1;
state.iaMarkerLayer      = L.layerGroup().addTo(map);
state.iaMarkers          = [];   // Leaflet marker refs, parallel to iaSuggestions
state.iaCoverageLayer    = L.layerGroup().addTo(map);
state.iaAdvisorTrackPts  = [];   // 300-pt track sent by backend
state.iaCoveredExisting  = new Set();   // indices covered by existing receivers
state.iaCoveredSuggested = new Set();   // indices covered by accepted suggestions
// Manual placement tester
state.iaTestLayer        = L.layerGroup().addTo(map);
state.iaTestMarker       = null;
// Cached complete-event data for summary bar updates
state.iaCompleteEvt      = null;
// Candidate site dots (shown during scoring, cleared after complete)
state.iaCandidateLayer   = L.layerGroup().addTo(map);
state.iaCandidateMarkers = {};  // keyed by cand_idx → L.circleMarker
// Live scoring state for candidate coloring
state.iaMinContribPct    = 0;        // min_contribution_pct from UI params
state.iaBestCandIdxSet   = new Set(); // all cand_idx tied at the current best coverage_pct
state.iaBestCandPct      = 0;        // that best coverage_pct
state.iaCandScores       = {};        // { cand_idx: { pct, backbone_blocked } }
// Step-by-step map visualization layers
state.iaTrackPreviewLayer = L.layerGroup().addTo(map);  // dashed track before coverage data
state.iaRoadsLayer        = L.layerGroup().addTo(map);  // OSM road network sketch
state.iaExclusionsLayer   = L.layerGroup().addTo(map);  // water/building exclusion polygons
state.iaHotZoneLayer      = L.layerGroup().addTo(map);  // coarse-scoring hot zone circles
state.iaRefineLayer       = L.layerGroup().addTo(map);  // 150 m refinement radius rings
state.iaHeatLayer         = null;                       // L.heatLayer — top-20% RF score overlay
// Area heat map (network coverage across the visible viewport)
state.heatMapLayer     = L.layerGroup().addTo(map);   // true-footprint colored cells
state.heatMapRunning   = false;
state.heatMapAbortCtrl = null;
state.heatMapStartTime = null;   // for time-remaining estimate
state.heatMapResults   = [];     // flat cell array, for cursor-signal lookup
state.heatMapSpacingM  = null;   // meters; nearest-cell lookup distance cutoff
state.heatMapReceivers = [];     // the receiver list this map was scored against
                                 // (best_rx_idx indexes into this, NOT state.receivers —
                                 //  a single-site map is scored against just one site)

// Haversine distance in km between two [lat,lon] points
function _haversineKm(lat1, lon1, lat2, lon2) {
  const R  = 6371;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Longest contiguous uncovered stretch (km) given current coverage state
function _iaLongestGapKm() {
  const pts = state.iaAdvisorTrackPts;
  if (pts.length < 2) return 0;
  let longest = 0, current = 0, lastPt = null;
  for (let i = 0; i < pts.length; i++) {
    if (!state.iaCoveredSuggested.has(i) && !state.iaCoveredExisting.has(i)) {
      if (lastPt !== null) {
        current += _haversineKm(lastPt[0], lastPt[1], pts[i][0], pts[i][1]);
        longest  = Math.max(longest, current);
      }
      lastPt = pts[i];
    } else {
      current = 0; lastPt = null;
    }
  }
  return longest;
}

// Refresh coverage summary bar below the progress bar
function _iaUpdateSummary() {
  const bar = document.getElementById('ia-summary-bar');
  if (!bar || !state.iaAdvisorTrackPts.length) return;
  const evt      = state.iaCompleteEvt;
  const existing = evt ? (evt.existing_coverage_pct ?? 0) : 0;
  const total    = evt ? (evt.final_coverage_pct   ?? 0) : 0;
  const gap      = _iaLongestGapKm();
  const added    = Math.max(0, total - existing).toFixed(1);
  bar.innerHTML  =
    (existing > 0
      ? `<span class="ia-summary-stat">Existing: <strong>${existing}%</strong></span>` +
        `<span class="ia-summary-stat">Suggested: <strong>+${added}%</strong></span>`
      : '') +
    `<span class="ia-summary-stat">Total: <strong>${total}%</strong></span>` +
    `<span class="ia-summary-stat">Longest gap: <strong>${gap.toFixed(1)} km</strong></span>`;
  bar.classList.remove('hidden');
}

function _iaCoverageState(idx) {
  if (state.iaCoveredSuggested.has(idx)) return 'suggested';
  if (state.iaCoveredExisting.has(idx))  return 'existing';
  return 'uncovered';
}

function _iaDrawCoverageTrack() {
  // Coverage coloring takes over from the dashed preview
  state.iaTrackPreviewLayer.clearLayers();
  state.iaCoverageLayer.clearLayers();
  const pts = state.iaAdvisorTrackPts;
  if (pts.length < 2) return;

  // Colors: uncovered=red, existing=amber, suggested=green
  const COLOR = { uncovered: '#e05252', existing: '#ff9800', suggested: '#4caf50' };

  let runState = _iaCoverageState(0);
  let runPts   = [pts[0]];

  for (let i = 1; i < pts.length; i++) {
    const s = _iaCoverageState(i);
    if (s === runState) {
      runPts.push(pts[i]);
    } else {
      // Close current run (include this point so segments join cleanly)
      runPts.push(pts[i]);
      L.polyline(runPts, { color: COLOR[runState], weight: 5, opacity: 0.85 })
        .addTo(state.iaCoverageLayer);
      runState = s;
      runPts   = [pts[i]];
    }
  }
  // Flush last run
  if (runPts.length >= 2) {
    L.polyline(runPts, { color: COLOR[runState], weight: 5, opacity: 0.85 })
      .addTo(state.iaCoverageLayer);
  }
}

// Update advisor defaults when tier changes
document.getElementById('ia-tier-select').addEventListener('change', function () {
  if (this.value === 'wide2') {
    document.getElementById('ia-ant-height').value = '6';
    document.getElementById('ia-max-walk').value   = '1000';
  } else {
    document.getElementById('ia-ant-height').value = '4';
    document.getElementById('ia-max-walk').value   = '500';
  }
});

// Patch checkReady() to also gate the advisor button
const _origCheckReady = checkReady;
checkReady = function () {
  _origCheckReady();
  const iaBtn = document.getElementById('ia-run-btn');
  if (iaBtn) {
    if (state.iaRunning) {
      iaBtn.textContent = '◼ Stop';
      iaBtn.className   = 'btn btn-danger btn-full';
      iaBtn.disabled    = false;
    } else {
      iaBtn.textContent = '▶ Suggest Locations';
      iaBtn.className   = 'btn btn-primary btn-full';
      iaBtn.disabled    = !state.kmlFile || state.analysisRunning;
    }
  }
};

document.getElementById('ia-run-btn').addEventListener('click', () => {
  if (state.iaRunning) {
    state.iaAbortCtrl?.abort();
  } else {
    startInfraAdvisor();
  }
});

function startInfraAdvisor() {
  if (state.iaRunning || state.analysisRunning) return;

  state.iaRunning        = true;
  state.iaSuggestions    = [];
  state.iaSelectedIdx    = -1;
  state.iaMarkerLayer.clearLayers();
  state.iaMarkers          = [];
  state.iaCoveredExisting  = new Set();
  state.iaCoveredSuggested = new Set();
  state.iaCoverageLayer.clearLayers();
  state.iaAbortCtrl      = new AbortController();
  state.iaMinContribPct  = parseFloat(document.getElementById('ia-min-contrib').value) || 0;
  state.iaBestCandIdxSet = new Set();
  state.iaBestCandPct    = 0;
  state.iaCandScores     = {};
  if (state.iaHeatLayer) { map.removeLayer(state.iaHeatLayer); state.iaHeatLayer = null; }

  const resultsEl  = document.getElementById('ia-results');
  const progressEl = document.getElementById('ia-progress-container');
  const statusEl   = document.getElementById('ia-status-msg');

  resultsEl.classList.add('hidden');
  resultsEl.innerHTML = '';
  progressEl.classList.remove('hidden');
  statusEl.textContent = '';
  document.getElementById('ia-progress-bar').style.width = '0%';
  document.getElementById('ia-progress-label').textContent = 'Initializing…';
  const importBtn = document.getElementById('ia-import-btn');
  importBtn.classList.add('hidden');
  importBtn.disabled = false;
  importBtn.textContent = '+ Add to Receivers';
  checkReady();

  const params = {
    kml_file:             state.kmlFile,
    freq_mhz:             parseFloat(document.getElementById('freq-select').value),
    tx_power_dbm:         parseFloat(document.getElementById('tx-power').value),
    tx_gain_dbi:          parseFloat(document.getElementById('tx-gain').value),
    sensitivity_dbm:      parseFloat(document.getElementById('rx-sens').value),
    veg_type:             document.getElementById('veg-loss').value,
    fade_margin_db:       parseFloat(document.getElementById('fade-margin').value) || 0,
    antenna_height_m:     parseFloat(document.getElementById('ia-ant-height').value) || 4,
    max_walk_m:           parseFloat(document.getElementById('ia-max-walk').value) || 500,
    max_locations:        parseInt(document.getElementById('ia-max-locs').value) || 5,
    target_coverage_pct:  parseFloat(document.getElementById('ia-target-pct').value) || 90,
    tier_hint:             document.getElementById('ia-tier-select').value || 'wide1',
    min_contribution_pct:  parseFloat(document.getElementById('ia-min-contrib').value) || 0,
    include_foot_trails:   document.getElementById('ia-foot-trails').checked,
    max_practical_range_m: (parseFloat(document.getElementById('max-range-km').value) || 75) * 1000,
  };
  if (document.getElementById('ia-use-existing').checked && state.receivers.length) {
    params.receivers = state.receivers.filter(r => (r.enabled ?? '1') !== '0');
  }

  fetch('/api/suggest-locations', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params),
    signal:  state.iaAbortCtrl.signal,
  }).then(res => {
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { _iaFinish(); return; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(line => {
          if (!line.startsWith('data: ')) return;
          try { _handleIaSSE(JSON.parse(line.slice(6))); } catch { /* skip */ }
        });
        pump();
      }).catch(() => _iaFinish());
    }
    pump();
  }).catch(err => {
    if (err.name !== 'AbortError') {
      document.getElementById('ia-status-msg').textContent = `Error: ${err.message}`;
    }
    _iaFinish();
  });
}

function _handleIaSSE(evt) {
  const statusEl   = document.getElementById('ia-status-msg');
  const progressEl = document.getElementById('ia-progress-label');
  const barEl      = document.getElementById('ia-progress-bar');

  switch (evt.type) {
    case 'status':
      statusEl.textContent  = evt.message;
      progressEl.textContent = evt.message;
      break;

    case 'elev_progress':
      if (evt.total > 0) {
        progressEl.textContent = evt.message || `Terrain tiles: ${evt.current}/${evt.total}`;
        barEl.style.width = `${Math.min(20, (evt.current / evt.total) * 20)}%`;
      }
      break;

    case 'osm_status':
      statusEl.textContent = evt.message;
      if (evt.candidate_count) {
        // Shown after coarse scoring — full RF scoring is next
        progressEl.textContent = `${evt.candidate_count} candidates → full RF scoring`;
        barEl.style.width = '53%';
      } else {
        // Initial road/exclusion fetch complete
        progressEl.textContent = evt.message;
        barEl.style.width = '22%';
      }
      break;

    case 'coarse_progress': {
      // Three sub-phases within the 22–53% range:
      //   terrain  → 22–27%
      //   score    → 27–50%
      //   hotzone  → 50–53%
      const frac = evt.total > 0 ? evt.current / evt.total : 0;
      let pct;
      if (evt.phase === 'terrain') {
        pct = 22 + frac * 5;
      } else if (evt.phase === 'hotzone') {
        pct = 50 + frac * 3;
      } else {
        pct = 27 + frac * 23;   // 'score' phase
      }
      progressEl.textContent = evt.message || `Coarse scoring: ${evt.current}/${evt.total}`;
      barEl.style.width = `${pct}%`;
      break;
    }

    case 'step_progress':
      // x/N count for the current step — above-bar label only, status line unchanged
      progressEl.textContent = evt.message;
      break;

    case 'refine_progress': {
      // Draw 150 m dashed rings around each selected site on the first event
      if (state.iaRefineLayer.getLayers().length === 0 && state.iaSuggestions.length > 0) {
        state.iaSuggestions.forEach(s => {
          L.circle([s.lat, s.lon], {
            radius: 150,
            color: '#00bcd4', weight: 1.5, opacity: 0.8, dashArray: '5 4',
            fillColor: '#00bcd4', fillOpacity: 0.07,
          }).addTo(state.iaRefineLayer);
        });
      }
      const frac = evt.total > 0 ? evt.current / evt.total : 0;
      progressEl.textContent = evt.message || `Refining: ${evt.current}/${evt.total}`;
      barEl.style.width = `${85 + frac * 10}%`;
      break;
    }

    case 'track_pts':
      state.iaAdvisorTrackPts = evt.pts || [];
      // Draw dashed gray preview immediately so the map isn't blank during tile/OSM fetch
      state.iaTrackPreviewLayer.clearLayers();
      if (state.iaAdvisorTrackPts.length > 1) {
        const prevLine = L.polyline(state.iaAdvisorTrackPts, {
          color: '#888', weight: 3, opacity: 0.55, dashArray: '7 5',
        });
        prevLine.addTo(state.iaTrackPreviewLayer);
        map.fitBounds(prevLine.getBounds(), { padding: [40, 40] });
      }
      updateLegend();
      break;

    case 'osm_roads':
      state.iaRoadsLayer.clearLayers();
      (evt.lines || []).forEach(pts => {
        if (pts.length > 1)
          L.polyline(pts, { color: '#555', weight: 1.2, opacity: 0.4 })
           .addTo(state.iaRoadsLayer);
      });
      updateLegend();
      break;

    case 'osm_exclusions':
      state.iaExclusionsLayer.clearLayers();
      (evt.polygons || []).forEach(pts => {
        if (pts.length > 2)
          L.polygon(pts, {
            color: '#c0392b', weight: 1, opacity: 0.55,
            fillColor: '#e74c3c', fillOpacity: 0.18,
          }).addTo(state.iaExclusionsLayer);
      });
      updateLegend();
      break;

    case 'hot_zones':
      state.iaHotZoneLayer.clearLayers();
      (evt.zones || []).forEach(z => {
        L.circle([z.lat, z.lon], {
          radius: evt.radius_m || 200,
          color: '#e67e22', weight: 1.5, opacity: 0.7,
          fillColor: '#f39c12', fillOpacity: 0.15,
        }).bindTooltip(`Hot zone (${z.count} coarse survivors)`, { permanent: false })
          .addTo(state.iaHotZoneLayer);
      });
      updateLegend();
      break;

    case 'existing_coverage':
      statusEl.textContent =
        `Existing ${evt.receiver_count} receiver(s) cover ${evt.coverage_pct}% — finding gaps…`;
      barEl.style.width = '21%';
      if (evt.covered_indices) {
        state.iaCoveredExisting = new Set(evt.covered_indices);
        _iaDrawCoverageTrack();
      }
      break;

    case 'scoring_progress': {
      const bestStr = state.iaBestCandPct > 0
        ? ` · Best: +${state.iaBestCandPct.toFixed(1)}%` : '';
      progressEl.textContent = `RF scoring: ${evt.current}/${evt.total}${bestStr}`;
      barEl.style.width = `${53 + (evt.current / evt.total) * 32}%`;
      break;
    }

    case 'candidates':
      // Pre-scoring layers have served their purpose — clear them before dots appear
      state.iaTrackPreviewLayer.clearLayers();
      state.iaRoadsLayer.clearLayers();
      state.iaHotZoneLayer.clearLayers();
      (evt.candidates || []).forEach(c => {
        const m = L.circleMarker([c.lat, c.lon], {
          radius: 5, color: '#888', fillColor: '#888',
          fillOpacity: 0.55, weight: 1,
        }).addTo(state.iaCandidateLayer);
        const tierLabel = c.tier === 2 ? 'Hike' : c.tier === 4 ? 'Hot-zone' : 'Road';
        m.bindTooltip(`Candidate (${tierLabel})`, {permanent: false});
        state.iaCandidateMarkers[c.idx] = m;
      });
      updateLegend();
      break;

    case 'candidate_scored': {
      const cm = state.iaCandidateMarkers[evt.idx];
      if (!cm) break;
      const pct      = evt.coverage_pct    || 0;
      const blocked  = evt.backbone_blocked || false;
      const minC     = state.iaMinContribPct || 0;

      // Remember this score for recoloring when the best changes
      state.iaCandScores[evt.idx] = { pct, backbone_blocked: blocked };

      // Helper: non-best color for a scored candidate
      const normalColor = (idx) => {
        const d = state.iaCandScores[idx] || {};
        return d.backbone_blocked ? '#555' : d.pct >= minC ? '#4caf50' : '#e05252';
      };

      if (!blocked && pct > state.iaBestCandPct) {
        // Strictly better — revert all previous tied-bests to normal color
        state.iaBestCandIdxSet.forEach(oldIdx => {
          const oldM = state.iaCandidateMarkers[oldIdx];
          if (oldM) oldM.setStyle({ color: normalColor(oldIdx),
                                    fillColor: normalColor(oldIdx),
                                    fillOpacity: 0.7, radius: 5 });
        });
        state.iaBestCandIdxSet = new Set([evt.idx]);
        state.iaBestCandPct    = pct;
        cm.setStyle({ color: '#9c27b0', fillColor: '#9c27b0', fillOpacity: 0.9, radius: 7 });
        progressEl.textContent = `RF scoring… Best candidate: +${pct.toFixed(1)}%`;
      } else if (!blocked && pct === state.iaBestCandPct && pct > 0) {
        // Tied — add to the purple set alongside existing bests
        state.iaBestCandIdxSet.add(evt.idx);
        cm.setStyle({ color: '#9c27b0', fillColor: '#9c27b0', fillOpacity: 0.9, radius: 7 });
      } else {
        const clr = normalColor(evt.idx);
        cm.setStyle({ color: clr, fillColor: clr, fillOpacity: 0.7, radius: 5 });
      }
      break;
    }

    case 'suggestion': {
      // Render RF score heat map on first suggestion (scoring is now complete)
      if (state.iaSuggestions.length === 0) _iaRenderHeatMap();
      // Remove candidate dot for this site before adding the ranked marker
      if (evt.cand_idx != null && state.iaCandidateMarkers[evt.cand_idx]) {
        state.iaCandidateLayer.removeLayer(state.iaCandidateMarkers[evt.cand_idx]);
        delete state.iaCandidateMarkers[evt.cand_idx];
      }
      state.iaSuggestions.push(evt);
      _addIaMarker(evt, state.iaSuggestions.length - 1);
      _appendIaResultItem(evt, state.iaSuggestions.length - 1);
      document.getElementById('ia-results').classList.remove('hidden');
      barEl.style.width = `${85 + (evt.rank / Math.max(evt.rank + 1, 2)) * 12}%`;
      if (evt.marginal_indices) {
        evt.marginal_indices.forEach(i => state.iaCoveredSuggested.add(i));
        _iaDrawCoverageTrack();
      }
      updateLegend();
      break;
    }

    case 'complete': {
      barEl.style.width = '100%';
      state.iaCompleteEvt = evt;
      const existing = evt.existing_coverage_pct ?? 0;
      const n = evt.selected_count;
      const nLabel = `${n} new site${n !== 1 ? 's' : ''}`;
      if (existing > 0) {
        const gain = Math.max(0, evt.final_coverage_pct - existing).toFixed(1);
        progressEl.textContent = n > 0
          ? `Done — ${nLabel}, +${gain}% (${evt.final_coverage_pct}% total)`
          : `Done — existing receivers already cover ${existing}%`;
      } else {
        progressEl.textContent =
          `Done — ${n} location${n !== 1 ? 's' : ''}, ${evt.final_coverage_pct}% coverage`;
      }
      if (n === 0) {
        const total      = evt.total_candidates ?? 0;
        const blocked    = evt.backbone_blocked_count ?? 0;
        const zeroCov    = evt.zero_coverage_count ?? 0;
        const bestMarg   = evt.best_marginal_pct ?? 0;
        const minContrib = evt.min_contribution_pct ?? 0;
        if (existing > 0 && evt.final_coverage_pct >= (evt.target_coverage_pct ?? 0)) {
          statusEl.textContent = `Target coverage already met by existing receivers (${existing}%).`;
        } else if (blocked > 0 && blocked === total) {
          statusEl.textContent =
            `No sites found — all ${total} candidates were backbone-blocked (no relay path to a WIDE2/iGate receiver). Add WIDE2/iGate receivers closer to the course, or switch to WIDE2 advisor mode.`;
        } else if (blocked > 0 && (blocked + zeroCov) === total) {
          statusEl.textContent =
            `No sites found — ${blocked} candidate${blocked !== 1 ? 's' : ''} backbone-blocked, remaining have no line-of-sight to the tracker. Terrain may be too obstructed.`;
        } else if (zeroCov === total && total > 0) {
          statusEl.textContent =
            `No sites found — terrain blocked all ${total} candidates from hearing the tracker. Try increasing antenna height or TX power.`;
        } else if (minContrib > 0 && bestMarg < minContrib) {
          statusEl.textContent =
            `No sites found — best available site only adds ${bestMarg}% coverage, below the ${minContrib}% minimum contribution threshold. Lower Min. Site Contribution and retry.`;
        } else {
          statusEl.textContent =
            'No viable sites found. Try lower fade margin, higher TX power, or check that roads exist near the course.';
        }
      } else {
        statusEl.textContent = '';
        document.getElementById('ia-import-btn').classList.remove('hidden');
      }
      state.iaCandidateLayer.clearLayers();
      state.iaCandidateMarkers = {};
      state.iaRefineLayer.clearLayers();
      _iaUpdateSummary();
      _iaFinish();
      break;
    }

    case 'error':
      statusEl.textContent = `Error: ${evt.message.split('\n')[0]}`;
      state.iaCandidateLayer.clearLayers();
      state.iaCandidateMarkers = {};
      state.iaTrackPreviewLayer.clearLayers();
      state.iaRoadsLayer.clearLayers();
      state.iaHotZoneLayer.clearLayers();
      state.iaRefineLayer.clearLayers();
      if (state.iaHeatLayer) { map.removeLayer(state.iaHeatLayer); state.iaHeatLayer = null; }
      _iaFinish();
      break;
  }
}

function _addIaMarker(suggestion, idx) {
  const isHike    = suggestion.tier === 2;
  const tierClass = suggestion.tier === 2 ? ' ia-tier-2' : suggestion.tier === 3 ? ' ia-tier-3' : '';
  const icon = L.divIcon({
    className: '',
    html: `<div class="ia-marker${tierClass}">${suggestion.rank}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
  const marker = L.marker([suggestion.lat, suggestion.lon], { icon })
    .bindTooltip(
      `<b>#${suggestion.rank} — ${isHike ? 'Hike-accessible' : suggestion.highway || 'Road'}</b><br>` +
      `Individual: ${suggestion.coverage_pct}%<br>` +
      `Marginal gain: +${suggestion.marginal_pct}%<br>` +
      `Cumulative: ${suggestion.cumulative_pct}%`,
      { direction: 'top', offset: [0, -12] }
    )
    .on('click', () => _selectIaSuggestion(idx));
  marker.addTo(state.iaMarkerLayer);
  state.iaMarkers.push(marker);
}

function _renderIaResults() {
  const container = document.getElementById('ia-results');
  container.innerHTML = '';
  state.iaSuggestions.forEach((s, i) => _appendIaResultItem(s, i));
  container.classList.toggle('hidden', state.iaSuggestions.length === 0);
  updateLegend();
}

function _appendIaResultItem(suggestion, idx) {
  const tierClass = suggestion.tier === 2 ? ' ia-tier-2' : suggestion.tier === 3 ? ' ia-tier-3' : '';
  const el = document.createElement('div');
  el.className = 'ia-item';
  el.dataset.iaIdx = idx;

  const covColor = coverageColor(suggestion.cumulative_pct);
  const tierLabel = suggestion.tier === 2 ? 'Hike' : suggestion.tier === 3 ? 'On-Route' : (suggestion.highway || 'Road');

  const alts    = suggestion.alternatives || [];
  const altHTML = alts.length
    ? `<div class="ia-alts">
        <span class="ia-alt-label">Alts:</span>` +
        alts.map((a, ai) => {
          const label = String.fromCharCode(65 + ai); // A, B
          return `<button class="ia-alt-pin" data-lat="${a.lat}" data-lon="${a.lon}"
                          title="${a.lat.toFixed(5)}, ${a.lon.toFixed(5)} (+${a.marginal_pct}%)"
                  >${label}: +${a.marginal_pct}% 📍</button>`;
        }).join('') +
       `</div>`
    : '';

  el.innerHTML = `
    <div class="ia-item-header">
      <span class="ia-rank-badge">#${suggestion.rank}</span>
      <span class="ia-tier-badge${tierClass}">${tierLabel}</span>
      <span style="flex:1;font-size:11px;color:var(--text-dim)">${suggestion.lat.toFixed(5)}, ${suggestion.lon.toFixed(5)}</span>
      <button class="ia-action-btn ia-add-btn" title="Add this site to receivers" data-idx="${idx}">+</button>
      <button class="ia-action-btn ia-del-btn" title="Remove this suggestion" data-idx="${idx}">🗑</button>
    </div>
    <div class="ia-cov-row">
      <span class="ia-cov-label">This site:</span>
      <span class="ia-cov-pct" style="color:${coverageColor(suggestion.coverage_pct)}">${suggestion.coverage_pct}%</span>
    </div>
    <div class="ia-cov-row">
      <span class="ia-cov-label">Marginal:</span>
      <span class="ia-cov-pct" style="color:var(--success)">+${suggestion.marginal_pct}%</span>
    </div>
    <div class="ia-cov-row">
      <span class="ia-cov-label">Cumulative:</span>
      <span class="ia-cov-pct" style="color:${covColor}">${suggestion.cumulative_pct}%</span>
      <div class="ia-cov-bar-wrap">
        <div class="ia-cov-bar-fill" style="width:${suggestion.cumulative_pct}%;background:${covColor}"></div>
      </div>
    </div>
    ${altHTML}
  `;
  el.querySelector('.ia-add-btn').addEventListener('click', e => {
    e.stopPropagation();
    _addSingleIaSuggestion(parseInt(e.currentTarget.dataset.idx));
  });
  el.querySelector('.ia-del-btn').addEventListener('click', e => {
    e.stopPropagation();
    _deleteIaSuggestion(parseInt(e.currentTarget.dataset.idx));
  });
  el.querySelectorAll('.ia-alt-pin').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const lat = parseFloat(btn.dataset.lat);
      const lon = parseFloat(btn.dataset.lon);
      _iaShowAltPin(lat, lon, btn.title);
    });
  });
  el.addEventListener('click', () => _selectIaSuggestion(idx));
  document.getElementById('ia-results').appendChild(el);
}

function _selectIaSuggestion(idx) {
  state.iaSelectedIdx = idx;

  // Update sidebar items
  document.querySelectorAll('.ia-item').forEach((el, i) =>
    el.classList.toggle('ia-selected', i === idx));

  // Update map markers
  state.iaMarkers.forEach((marker, i) => {
    const iconEl = marker.getElement()?.querySelector('.ia-marker');
    if (iconEl) iconEl.classList.toggle('ia-selected', i === idx);
  });

  // Pan map to selected marker
  const s = state.iaSuggestions[idx];
  if (s) map.panTo([s.lat, s.lon]);
}

// Show a temporary pin for an alternative location
let _altPinMarker = null;
function _iaShowAltPin(lat, lon, tooltip) {
  if (_altPinMarker) { map.removeLayer(_altPinMarker); _altPinMarker = null; }
  _altPinMarker = L.marker([lat, lon], {
    icon: L.divIcon({
      className: '',
      html: '<div class="ia-test-marker" style="border-color:#ff9800;box-shadow:0 0 0 3px rgba(255,152,0,0.25)">📍</div>',
      iconSize: [28, 28], iconAnchor: [14, 14],
    }),
  })
  .bindTooltip(tooltip, { permanent: false, direction: 'top', offset: [0, -14] })
  .addTo(map)
  .openTooltip();
  map.panTo([lat, lon]);
  // Auto-remove after 6 seconds
  setTimeout(() => {
    if (_altPinMarker) { map.removeLayer(_altPinMarker); _altPinMarker = null; }
  }, 6000);
}

// Draw test-site coverage on iaTestLayer in cyan
function _iaDrawTestCoverage(coveredIndices, trackPts) {
  state.iaTestLayer.clearLayers();
  if (!trackPts || trackPts.length < 2) return;
  const covered = new Set(coveredIndices);
  let runPts = [trackPts[0]], runCov = covered.has(0);
  for (let i = 1; i < trackPts.length; i++) {
    const c = covered.has(i);
    if (c === runCov) {
      runPts.push(trackPts[i]);
    } else {
      runPts.push(trackPts[i]);
      L.polyline(runPts, { color: runCov ? '#4dd0e1' : '#2a2e45', weight: runCov ? 5 : 2, opacity: runCov ? 0.9 : 0.6 })
        .addTo(state.iaTestLayer);
      runCov = c; runPts = [trackPts[i]];
    }
  }
  if (runPts.length >= 2) {
    L.polyline(runPts, { color: runCov ? '#4dd0e1' : '#2a2e45', weight: runCov ? 5 : 2, opacity: runCov ? 0.9 : 0.6 })
      .addTo(state.iaTestLayer);
  }
}

// ---------------------------------------------------------------------------
// Receiver right-click context menu + edit modal
// ---------------------------------------------------------------------------

let _editRxIdx = -1;

function _showRxContextMenu(domEvent, rxIdx) {
  _hideIaTestMenu();
  const rx = state.receivers[rxIdx];
  if (!rx) return;

  const canFocus = !!(state.kmlFile && state.csvFile);

  const div = document.createElement('div');
  div.id        = 'ia-test-menu';
  div.className = 'ia-test-popup';
  div.style.left = domEvent.clientX + 'px';
  div.style.top  = domEvent.clientY + 'px';
  div.innerHTML =
    `<div class="ia-test-coords">${escapeHtml(rx.name || `RX${rxIdx + 1}`)}</div>` +
    `<button class="btn btn-primary" id="rx-ctx-edit">✏️ Edit parameters</button>` +
    (canFocus
      ? `<button class="btn btn-primary" id="rx-ctx-focus">📡 Focus analysis</button>`
      : '') +
    `<button class="btn btn-primary" id="rx-ctx-heatcov">🔥 Heat coverage map</button>` +
    `<button class="btn" id="ia-test-cancel">Cancel</button>`;
  document.body.appendChild(div);
  div.addEventListener('click', e => e.stopPropagation());

  div.querySelector('#rx-ctx-edit').addEventListener('click', () => {
    _hideIaTestMenu();
    _openRxEditModal(rxIdx);
  });
  if (canFocus) {
    div.querySelector('#rx-ctx-focus').addEventListener('click', () => {
      _hideIaTestMenu();
      const sel = document.getElementById('single-rx-select');
      if (sel) sel.value = rx.name;
      startAnalysis('track');
    });
  }
  div.querySelector('#rx-ctx-heatcov').addEventListener('click', () => {
    _hideIaTestMenu();
    _hmGenerate({ receivers: [state.receivers[rxIdx]], resolution: 'balanced' });
  });
  div.querySelector('#ia-test-cancel').addEventListener('click', _hideIaTestMenu);
  setTimeout(() => document.addEventListener('click', _hideIaTestMenu, { once: true }), 10);
}

function _openRxEditModal(rxIdx) {
  const rx = state.receivers[rxIdx];
  if (!rx) return;
  _editRxIdx = rxIdx;

  document.getElementById('edit-rx-title').textContent   = `Edit — ${rx.name || `RX${rxIdx + 1}`}`;
  document.getElementById('edit-rx-name').value          = rx.name             || '';
  document.getElementById('edit-rx-height').value        = rx.height_agl_m     ?? 2;
  document.getElementById('edit-rx-gain').value          = rx.antenna_gain_dbi ?? 0;
  document.getElementById('edit-rx-power').value         = _snapPower(rx.tx_power_dbm ?? 28);
  document.getElementById('edit-rx-role').value          = _rxRole(rx);
  document.getElementById('edit-rx-enabled').checked     = _rxEnabled(rx);

  document.getElementById('edit-rx-modal').classList.remove('hidden');
}

function _closeRxEditModal() {
  document.getElementById('edit-rx-modal').classList.add('hidden');
  _editRxIdx = -1;
}

document.getElementById('edit-rx-modal-close').addEventListener('click', _closeRxEditModal);
document.getElementById('edit-rx-cancel').addEventListener('click', _closeRxEditModal);

document.getElementById('edit-rx-save').addEventListener('click', async () => {
  const rxIdx = _editRxIdx;
  if (rxIdx < 0 || rxIdx >= state.receivers.length) return;

  const rx = state.receivers[rxIdx];
  rx.name             = document.getElementById('edit-rx-name').value.trim() || rx.name;
  rx.height_agl_m     = document.getElementById('edit-rx-height').value;
  rx.antenna_gain_dbi = document.getElementById('edit-rx-gain').value;
  rx.tx_power_dbm     = document.getElementById('edit-rx-power').value;
  rx.role             = document.getElementById('edit-rx-role').value;
  rx.enabled          = document.getElementById('edit-rx-enabled').checked ? '1' : '0';

  _closeRxEditModal();

  // Rebuild only receiver markers (preserve analysis overlay)
  rxLayer.clearLayers();
  state.receivers.forEach((r, i) => _addRxMarker(r, i));
  updateLegend();
  updateSingleRxSelect();

  if (!state.csvFile) { setStatus(`${rx.name} updated (no CSV file to save).`); return; }

  showTransferSpinner(`Saving ${rx.name}…`);
  try {
    const res  = await fetch(`/api/csv/${encodeURIComponent(state.csvFile)}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ rows: state.receivers }),
    });
    const data = await res.json();
    if (data.ok) {
      // Only sync the FM editor cache if it's currently showing this same
      // file — otherwise we'd clobber unsaved edits on a different file.
      if (fm.editorFile === state.csvFile) {
        fm.editorRows = state.receivers.map(r => ({ ...r }));
        renderFmEditorTable();
      }
      setStatus(`${rx.name} saved to ${state.csvFile}.`);
    } else {
      setStatus(`${rx.name} updated in memory — CSV save failed.`);
    }
  } catch (err) {
    setStatus(`${rx.name} updated in memory — save error: ${err.message}`);
  } finally {
    hideTransferSpinner();
  }
});

// Right-click context menu for manual placement testing
function _hideIaTestMenu() {
  const el = document.getElementById('ia-test-menu');
  if (el) el.remove();
}

map.on('contextmenu', (e) => {
  e.originalEvent.preventDefault();
  _hideIaTestMenu();
  if (_altPinMarker) { map.removeLayer(_altPinMarker); _altPinMarker = null; }

  const div = document.createElement('div');
  div.id = 'ia-test-menu';
  div.className = 'ia-test-popup';
  div.style.left = e.originalEvent.clientX + 'px';
  div.style.top  = e.originalEvent.clientY + 'px';
  div.innerHTML  =
    `<div class="ia-test-coords">${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}</div>` +
    (state.kmlFile
      ? `<button class="btn btn-primary" id="ia-test-go">📡 Test site coverage</button>`
      : '') +
    `<button class="btn btn-primary" id="ia-heatcov-go">🔥 Heat coverage map</button>` +
    `<button class="btn" id="ia-test-cancel">Cancel</button>`;
  document.body.appendChild(div);
  div.addEventListener('click', e => e.stopPropagation());

  if (state.kmlFile) {
    div.querySelector('#ia-test-go').addEventListener('click', () => {
      _hideIaTestMenu();
      _iaTestLocation(e.latlng);
    });
  }
  div.querySelector('#ia-heatcov-go').addEventListener('click', () => {
    _hideIaTestMenu();
    _hmGenerate({
      receivers: [{
        name: `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`,
        latitude: e.latlng.lat, longitude: e.latlng.lng,
        height_agl_m: 2, antenna_gain_dbi: 0, enabled: '1',
      }],
      resolution: 'balanced',
    });
  });
  div.querySelector('#ia-test-cancel').addEventListener('click', _hideIaTestMenu);

  // Dismiss on next map click or outside click
  setTimeout(() => document.addEventListener('click', _hideIaTestMenu, { once: true }), 10);
});

// ---------------------------------------------------------------------------
// Area heat map — network coverage across the visible viewport, scored
// against ALL enabled receivers (not tied to any loaded track/roads/trails)
// ---------------------------------------------------------------------------

function _hmSetUI({ progressVisible, label, pct, status, summaryHtml } = {}) {
  const progressEl = document.getElementById('hm-progress-container');
  const labelEl    = document.getElementById('hm-progress-label');
  const barEl      = document.getElementById('hm-progress-bar');
  const statusEl   = document.getElementById('hm-status-msg');
  const summaryEl  = document.getElementById('hm-summary-bar');
  if (progressVisible !== undefined) progressEl.classList.toggle('hidden', !progressVisible);
  if (label       !== undefined) labelEl.textContent = label;
  if (pct         !== undefined) barEl.style.width = `${pct}%`;
  if (status      !== undefined) statusEl.textContent = status;
  if (summaryHtml !== undefined) {
    summaryEl.innerHTML = summaryHtml;
    summaryEl.classList.toggle('hidden', !summaryHtml);
  }
}

// 3-stop gradient (weak → strong), matching the app's existing RF-score
// heat overlay colors, evaluated per-cell instead of screen-space blurred.
// Stops land on clean 10 dB bands of the 0-30 dB margin range (see the
// "Coverage Heat Map" legend in updateLegend()): 0-10 dB blue, 10-20 dB
// blue->orange, 20-30 dB orange->red.
function _hmColor(t) {
  const stops = [[0, 33, 150, 243], [1 / 3, 33, 150, 243], [2 / 3, 255, 152, 0], [1, 244, 67, 54]];
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    const [t0, r0, g0, b0] = stops[i - 1];
    const [t1, r1, g1, b1] = stops[i];
    if (t <= t1) {
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return `rgb(${Math.round(r0 + (r1 - r0) * f)},${Math.round(g0 + (g1 - g0) * f)},${Math.round(b0 + (b1 - b0) * f)})`;
    }
  }
  return 'rgb(244,67,54)';
}

// True-footprint rectangle for one grid cell, sized to the analysis spacing
// in real-world meters rather than a fixed pixel radius, so the same cell
// always covers the same ground area -- no reflow/reinterpretation on zoom.
function _hmCellBounds(lat, lon, spacingM) {
  const dLat = (spacingM / 111320) / 2;
  const dLon = (spacingM / (111320 * Math.cos(lat * Math.PI / 180))) / 2;
  return [[lat - dLat, lon - dLon], [lat + dLat, lon + dLon]];
}

function _hmFmtRemaining(secs) {
  secs = Math.max(0, Math.round(secs));
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// Show/hide the "Heat" field in the cursor info bar based on whether any
// heat map data currently exists to look up (independent of the "Signal"
// field above it, so both a track analysis and a heat map can show at once).
function _hmUpdateInfoBarVisibility() {
  const hasHeat = state.heatMapResults.length > 0;
  document.getElementById('info-heat-sep').classList.toggle('hidden', !hasHeat);
  document.getElementById('info-heat-group').classList.toggle('hidden', !hasHeat);
}

// opts.receivers  — score against this list instead of all loaded receivers
//                   (single-element = single-site heat map from a right-click menu)
// opts.resolution — force a grid resolution instead of reading the panel dropdown
async function _hmGenerate(opts = {}) {
  if (state.heatMapRunning) { state.heatMapAbortCtrl?.abort(); return; }
  const receivers = opts.receivers || state.receivers;
  if (!receivers || receivers.length === 0) {
    _hmSetUI({ status: 'Load a receivers CSV first.' });
    return;
  }

  const b      = map.getBounds();
  const params = {
    sw_lat: b.getSouth(), sw_lon: b.getWest(),
    ne_lat: b.getNorth(), ne_lon: b.getEast(),
    resolution:      opts.resolution || document.getElementById('hm-resolution').value,
    freq_mhz:        parseFloat(document.getElementById('freq-select').value)   || 433,
    tx_power_dbm:    parseFloat(document.getElementById('tx-power').value)      || 22,
    tx_gain_dbi:     parseFloat(document.getElementById('tx-gain').value)       || 0,
    sensitivity_dbm: parseFloat(document.getElementById('rx-sens').value)       || -135,
    veg_type:        document.getElementById('veg-loss').value                 || 'none',
    fade_margin_db:  parseFloat(document.getElementById('fade-margin').value)   || 0,
    chain_mode:      document.getElementById('chain-mode-toggle').checked,
    receivers:       receivers,
  };
  const threshold = params.sensitivity_dbm + params.fade_margin_db;

  state.heatMapLayer.clearLayers();
  const canvasR = L.canvas({ padding: 0.5 });
  let spacingM  = null;

  state.heatMapRunning   = true;
  state.heatMapAbortCtrl = new AbortController();
  state.heatMapStartTime = null;
  state.heatMapResults   = [];
  state.heatMapSpacingM  = null;
  state.heatMapReceivers = receivers;
  _hmUpdateInfoBarVisibility();
  checkReady();
  _hmSetUI({ progressVisible: true, label: 'Initializing…', pct: 0, status: '', summaryHtml: '' });

  try {
    const res = await fetch('/api/area-coverage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(params),
      signal:  state.heatMapAbortCtrl.signal,
    });
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let coveredCt = 0, totalCt = 0, errored = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'grid_info') {
            spacingM = evt.spacing_m;
            totalCt  = evt.total;
            state.heatMapSpacingM = evt.spacing_m;
          } else if (evt.type === 'status') {
            _hmSetUI({ label: evt.message, status: evt.message });
          } else if (evt.type === 'elev_progress') {
            if (evt.total > 0) {
              _hmSetUI({ label: evt.message, pct: Math.min(20, (evt.current / evt.total) * 20) });
            }
          } else if (evt.type === 'area_batch') {
            if (!state.heatMapStartTime) state.heatMapStartTime = Date.now();
            for (const c of evt.cells) {
              state.heatMapResults.push(c);
              if (c.coverage) {
                const margin = Math.max(0, Math.min(1, (c.best_rssi - threshold) / 30));
                const color  = _hmColor(margin);
                L.rectangle(_hmCellBounds(c.lat, c.lon, spacingM || 200), {
                  color, weight: 0, fillColor: color, fillOpacity: 0.55, renderer: canvasR,
                }).addTo(state.heatMapLayer);
              }
            }
            _hmUpdateInfoBarVisibility();
            let label = `Processing ${evt.done}/${evt.total} cells…`;
            const elapsed = (Date.now() - state.heatMapStartTime) / 1000;
            if (elapsed > 4 && evt.done > 20) {
              const rate     = evt.done / elapsed;
              const secsLeft = (evt.total - evt.done) / rate;
              label += ` ${_hmFmtRemaining(secsLeft)} remaining`;
            }
            _hmSetUI({ label, pct: 20 + Math.min(80, (evt.done / evt.total) * 80) });
          } else if (evt.type === 'complete') {
            coveredCt = evt.covered; totalCt = evt.total; spacingM = evt.spacing_m;
            state.heatMapSpacingM = evt.spacing_m;
          } else if (evt.type === 'error') {
            errored = true;
            _hmSetUI({ status: `Heat map error: ${evt.message}`, summaryHtml: '' });
          }
        } catch { /* ignore parse errors */ }
      }
    }

    if (errored) {
      _hmSetUI({ progressVisible: false });
    } else {
      const pct = totalCt > 0 ? ((coveredCt / totalCt) * 100).toFixed(1) : '0';
      _hmSetUI({
        progressVisible: false,
        status: `Heat map: ${pct}% of visible area covered.`,
        summaryHtml:
          `<span class="ia-summary-stat">Covered: <strong>${pct}%</strong></span>` +
          `<span class="ia-summary-stat">Cells: <strong>${totalCt}</strong></span>` +
          `<span class="ia-summary-stat">Spacing: <strong>${(spacingM || 0).toFixed(0)} m</strong></span>`,
      });
    }
  } catch (err) {
    if (err.name !== 'AbortError') _hmSetUI({ status: `Heat map failed: ${err.message}` });
    _hmSetUI({ progressVisible: false });
  } finally {
    state.heatMapRunning = false;
    checkReady();
    updateLegend();
  }
}

function _hmClear() {
  state.heatMapAbortCtrl?.abort();
  state.heatMapRunning  = false;
  state.heatMapResults  = [];
  state.heatMapSpacingM = null;
  state.heatMapReceivers = [];
  state.heatMapLayer.clearLayers();
  _hmUpdateInfoBarVisibility();
  _hmSetUI({ progressVisible: false, status: '', summaryHtml: '' });
  checkReady();
  updateLegend();
}

document.getElementById('hm-run-btn').addEventListener('click', () => _hmGenerate());
document.getElementById('hm-clear-btn').addEventListener('click', _hmClear);

// Gate the heat map button alongside the advisor button
const _origCheckReadyHm = checkReady;
checkReady = function () {
  _origCheckReadyHm();
  const hmBtn = document.getElementById('hm-run-btn');
  if (hmBtn) {
    if (state.heatMapRunning) {
      hmBtn.textContent = '◼ Stop';
      hmBtn.className   = 'btn btn-danger';
      hmBtn.style.flex  = '1';
    } else {
      hmBtn.textContent = '▶ Generate Heat Map';
      hmBtn.className   = 'btn btn-primary';
      hmBtn.style.flex  = '1';
      hmBtn.disabled    = !state.receivers || state.receivers.length === 0;
    }
  }
};

async function _iaTestLocation(latlng) {
  // Remove previous test
  state.iaTestLayer.clearLayers();
  if (state.iaTestMarker) { map.removeLayer(state.iaTestMarker); state.iaTestMarker = null; }

  // Spinner marker while loading
  state.iaTestMarker = L.marker([latlng.lat, latlng.lng], {
    icon: L.divIcon({
      className: '',
      html: '<div class="ia-test-marker">⏳</div>',
      iconSize: [28, 28], iconAnchor: [14, 14],
    }),
  }).addTo(map);

  const antH = parseFloat(document.getElementById('ia-ant-height')?.value) || 4;
  const params = {
    lat:             latlng.lat,
    lon:             latlng.lng,
    height_agl_m:    antH,
    kml_file:        state.kmlFile,
    freq_mhz:        parseFloat(document.getElementById('freq-select').value)  || 433,
    tx_power_dbm:    parseFloat(document.getElementById('tx-power').value)     || 22,
    tx_gain_dbi:     parseFloat(document.getElementById('tx-gain').value)      || 0,
    sensitivity_dbm: parseFloat(document.getElementById('rx-sens').value)      || -135,
    veg_type:        document.getElementById('veg-loss').value                 || 'none',
    fade_margin_db:  parseFloat(document.getElementById('fade-margin').value)  || 0,
  };

  try {
    const res     = await fetch('/api/test-location', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'status') {
            setStatus(evt.message);
          } else if (evt.type === 'complete') {
            map.removeLayer(state.iaTestMarker);
            _iaDrawTestCoverage(evt.covered_indices, evt.track_pts);
            state.iaTestMarker = L.marker([latlng.lat, latlng.lng], {
              icon: L.divIcon({
                className: '',
                html: '<div class="ia-test-marker">📡</div>',
                iconSize: [28, 28], iconAnchor: [14, 14],
              }),
            }).addTo(map);
            L.popup({ maxWidth: 220 })
              .setLatLng([latlng.lat, latlng.lng])
              .setContent(
                `<b>Test Site</b><br>` +
                `Coverage: <b>${evt.coverage_pct}%</b><br>` +
                `Longest uncovered gap: <b>${evt.longest_gap_km} km</b><br>` +
                `<div style="display:flex;gap:6px;margin-top:6px">` +
                `<button onclick="window._iaAddTestSite(${latlng.lat},${latlng.lng})" ` +
                `style="flex:1;padding:3px 0;background:#4caf7d;color:#fff;border:none;border-radius:4px;cursor:pointer">` +
                `+ Add as Receiver</button>` +
                `<button onclick="window._iaClearTest()" ` +
                `style="flex:1;padding:3px 0;background:#2a2e45;color:#dde1f0;border:1px solid #2e3350;border-radius:4px;cursor:pointer">` +
                `Clear</button></div>`
              )
              .openOn(map);
            state.iaTestMarker._testData = { lat: latlng.lat, lon: latlng.lng, coverage_pct: evt.coverage_pct };
            setStatus(`Test site: ${evt.coverage_pct}% coverage, longest gap ${evt.longest_gap_km} km`);
          } else if (evt.type === 'error') {
            if (state.iaTestMarker) { map.removeLayer(state.iaTestMarker); state.iaTestMarker = null; }
            setStatus(`Test error: ${evt.message.split('\n')[0]}`);
          }
        } catch { /* ignore SSE parse errors */ }
      }
    }
  } catch (err) {
    if (state.iaTestMarker) { map.removeLayer(state.iaTestMarker); state.iaTestMarker = null; }
    setStatus(`Test failed: ${err.message}`);
  }
}

// Global handlers for popup onclick (Leaflet popup can't use closures)
window._iaClearTest = function () {
  state.iaTestLayer.clearLayers();
  if (state.iaTestMarker) { map.removeLayer(state.iaTestMarker); state.iaTestMarker = null; }
  map.closePopup();
};

window._iaAddTestSite = async function (lat, lon) {
  map.closePopup();
  const antH = parseFloat(document.getElementById('ia-ant-height')?.value) || 4;
  const tier  = document.getElementById('ia-tier-select')?.value || 'wide1';
  const rx = {
    name:             `Test-${lat.toFixed(4)},${lon.toFixed(4)}`,
    latitude:         lat.toFixed(6),
    longitude:        lon.toFixed(6),
    height_agl_m:     String(antH),
    antenna_gain_dbi: '0',
    tx_power_dbm:     '22',
    enabled:          '1',
    role:             tier,
  };
  const rxIdx = state.receivers.length;
  state.receivers.push(rx);
  _addRxMarker(rx, rxIdx);
  updateLegend();
  checkReady();

  if (state.csvFile) {
    showTransferSpinner(`Saving ${state.csvFile}…`);
    try {
      const res  = await fetch(`/api/csv/${encodeURIComponent(state.csvFile)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: state.receivers }),
      });
      const d = await res.json();
      if (d.ok) { fm.editorFile = state.csvFile; fm.editorRows = state.receivers.map(r => ({...r})); }
      setStatus(`Added test site to ${state.csvFile}.`);
    } catch (e) { setStatus(`Added to map — save error: ${e.message}`); }
    finally { hideTransferSpinner(); }
  } else {
    showTransferSpinner('Creating receivers CSV…');
    try {
      const lines = [CSV_COLS.join(',')];
      state.receivers.forEach(row => {
        lines.push(CSV_COLS.map(c => { const v = String(row[c] ?? ''); return v.includes(',') ? `"${v.replace(/"/g,'""')}"` : v; }).join(','));
      });
      const ts = new Date().toISOString().slice(0,19).replace(/[T:]/g,'-');
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      const fd   = new FormData();
      fd.append('file', new File([blob], `advisor-${ts}.csv`, { type: 'text/csv' }));
      const res  = await fetch('/api/upload/csv', { method: 'POST', body: fd });
      const d    = await res.json();
      if (d.filename) {
        state.csvFile = d.filename; fm.editorFile = d.filename;
        fm.editorRows = state.receivers.map(r => ({...r})); fm.selCsv = d.filename;
        await refreshFmFileLists(); updateSidebarBtns();
        setStatus(`Added test site — created ${d.filename}.`);
      }
    } catch (e) { setStatus(`Added to map — CSV error: ${e.message}`); }
    finally { hideTransferSpinner(); }
  }
  _iaClearTest();
};

function _deleteIaSuggestion(idx) {
  if (state.iaMarkers[idx]) {
    state.iaMarkerLayer.removeLayer(state.iaMarkers[idx]);
  }
  state.iaSuggestions.splice(idx, 1);
  state.iaMarkers.splice(idx, 1);
  // Recompute covered-by-suggestions from remaining suggestions' marginal_indices
  state.iaCoveredSuggested = new Set();
  state.iaSuggestions.forEach(s => {
    (s.marginal_indices || []).forEach(i => state.iaCoveredSuggested.add(i));
  });
  _iaDrawCoverageTrack();
  _iaUpdateSummary();
  _renderIaResults();
  if (!state.iaSuggestions.length) {
    document.getElementById('ia-import-btn').classList.add('hidden');
  }
}

async function _addSingleIaSuggestion(idx) {
  const s    = state.iaSuggestions[idx];
  if (!s) return;
  const antH = parseFloat(document.getElementById('ia-ant-height').value) || 4;
  const tier = document.getElementById('ia-tier-select').value || 'wide1';
  const rx = {
    name:             `Advisor-${s.rank}`,
    latitude:         s.lat.toFixed(6),
    longitude:        s.lon.toFixed(6),
    height_agl_m:     String(antH),
    antenna_gain_dbi: '0',
    tx_power_dbm:     '22',
    enabled:          '1',
    role:             tier,
  };
  const rxIdx = state.receivers.length;
  state.receivers.push(rx);
  _addRxMarker(rx, rxIdx);
  updateLegend();
  checkReady();

  const csvRows = state.receivers;

  if (state.csvFile) {
    showTransferSpinner(`Saving ${state.csvFile}…`);
    try {
      const res  = await fetch(`/api/csv/${encodeURIComponent(state.csvFile)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: csvRows }),
      });
      const data = await res.json();
      if (data.ok) {
        fm.editorFile = state.csvFile;
        fm.editorRows = csvRows.map(r => ({ ...r }));
        setStatus(`Added ${rx.name} to receivers and saved to ${state.csvFile}.`);
      } else {
        setStatus(`${rx.name} added to map — CSV save failed.`);
      }
    } catch (err) {
      setStatus(`${rx.name} added to map — save error: ${err.message}`);
    } finally {
      hideTransferSpinner();
    }
  } else {
    showTransferSpinner('Creating receivers CSV…');
    try {
      const lines = [CSV_COLS.join(',')];
      csvRows.forEach(row => {
        lines.push(CSV_COLS.map(c => {
          const v = String(row[c] ?? '');
          return v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(','));
      });
      const ts       = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const filename = `advisor-${ts}.csv`;
      const blob     = new Blob([lines.join('\n')], { type: 'text/csv' });
      const fd       = new FormData();
      fd.append('file', new File([blob], filename, { type: 'text/csv' }));
      const res  = await fetch('/api/upload/csv', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.filename) {
        state.csvFile  = data.filename;
        fm.editorFile  = data.filename;
        fm.editorRows  = csvRows.map(r => ({ ...r }));
        fm.selCsv      = data.filename;
        await refreshFmFileLists();
        updateSidebarBtns();
        setStatus(`Added ${rx.name} — created ${data.filename}.`);
      }
    } catch (err) {
      setStatus(`${rx.name} added to map — CSV create error: ${err.message}`);
    } finally {
      hideTransferSpinner();
    }
  }
}

function _iaClear() {
  if (state.iaRunning && state.iaAbortCtrl) {
    state.iaAbortCtrl.abort();
  }
  state.iaMarkerLayer.clearLayers();
  state.iaCoverageLayer.clearLayers();
  state.iaCandidateLayer.clearLayers();
  state.iaCandidateMarkers = {};
  state.iaTestLayer.clearLayers();
  state.iaTrackPreviewLayer.clearLayers();
  state.iaRoadsLayer.clearLayers();
  state.iaExclusionsLayer.clearLayers();
  state.iaHotZoneLayer.clearLayers();
  state.iaRefineLayer.clearLayers();
  if (state.iaHeatLayer) { map.removeLayer(state.iaHeatLayer); state.iaHeatLayer = null; }
  if (state.iaTestMarker) { map.removeLayer(state.iaTestMarker); state.iaTestMarker = null; }
  _hideIaTestMenu();
  state.iaSuggestions      = [];
  state.iaMarkers          = [];
  state.iaSelectedIdx      = null;
  state.iaRunning          = false;
  state.iaAbortCtrl        = null;
  state.iaAdvisorTrackPts  = [];
  state.iaCoveredExisting  = new Set();
  state.iaCoveredSuggested = new Set();
  state.iaCompleteEvt      = null;
  state.iaBestCandIdxSet   = new Set();
  state.iaBestCandPct      = 0;
  state.iaCandScores       = {};
  document.getElementById('ia-results').innerHTML = '';
  document.getElementById('ia-results').classList.add('hidden');
  document.getElementById('ia-import-btn').classList.add('hidden');
  document.getElementById('ia-progress-container').classList.add('hidden');
  document.getElementById('ia-summary-bar').classList.add('hidden');
  document.getElementById('ia-status-msg').textContent  = '';
  document.getElementById('ia-progress-label').textContent = 'Initializing…';
  document.getElementById('ia-progress-bar').style.width = '0%';
  updateLegend();
  checkReady();
}

function _iaFinish() {
  state.iaRunning   = false;
  state.iaAbortCtrl = null;
  checkReady();
  // Hide progress bar after a short delay so users can see the final state
  setTimeout(() => {
    document.getElementById('ia-progress-container').classList.add('hidden');
  }, 1500);
}

document.getElementById('ia-import-btn').addEventListener('click', _iaImportReceivers);
document.getElementById('ia-clear-btn').addEventListener('click', _iaClear);

async function _iaImportReceivers() {
  if (!state.iaSuggestions.length) return;

  const antH  = parseFloat(document.getElementById('ia-ant-height').value) || 4;
  const tier  = document.getElementById('ia-tier-select').value || 'wide1';
  const added = [];

  state.iaSuggestions.forEach((s, i) => {
    const rx = {
      name:             `Advisor-${s.rank}`,
      latitude:         s.lat.toFixed(6),
      longitude:        s.lon.toFixed(6),
      height_agl_m:     String(antH),
      antenna_gain_dbi: '0',
      tx_power_dbm:     '22',
      enabled:          '1',
      role:             tier,
    };
    const idx = state.receivers.length;
    state.receivers.push(rx);
    _addRxMarker(rx, idx);
    added.push(rx.name);
  });

  checkReady();
  document.getElementById('ia-import-btn').disabled = true;
  document.getElementById('ia-import-btn').textContent = 'Added!';

  const csvRows = state.receivers;

  if (state.csvFile) {
    showTransferSpinner(`Saving ${state.csvFile}…`);
    try {
      const res  = await fetch(`/api/csv/${encodeURIComponent(state.csvFile)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: csvRows }),
      });
      const data = await res.json();
      if (data.ok) {
        fm.editorFile = state.csvFile;
        fm.editorRows = csvRows.map(r => ({ ...r }));
        setStatus(`Added ${added.length} advisor site(s) to ${state.csvFile}.`);
      } else {
        setStatus('Receivers added to map — CSV save failed.');
      }
    } catch (err) {
      setStatus(`Receivers added — save error: ${err.message}`);
    } finally {
      hideTransferSpinner();
    }
  } else {
    // No CSV loaded — create a new one
    showTransferSpinner('Creating receivers CSV…');
    try {
      const lines = [CSV_COLS.join(',')];
      csvRows.forEach(row => {
        lines.push(CSV_COLS.map(c => {
          const v = String(row[c] ?? '');
          return v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(','));
      });
      const ts       = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const filename = `advisor-${ts}.csv`;
      const blob     = new Blob([lines.join('\n')], { type: 'text/csv' });
      const fd       = new FormData();
      fd.append('file', new File([blob], filename, { type: 'text/csv' }));
      const res  = await fetch('/api/upload/csv', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.filename) {
        state.csvFile  = data.filename;
        fm.editorFile  = data.filename;
        fm.editorRows  = csvRows.map(r => ({ ...r }));
        fm.selCsv      = data.filename;
        await refreshFmFileLists();
        updateSidebarBtns();
        setStatus(`Created ${data.filename} with ${added.length} advisor site(s).`);
      }
    } catch (err) {
      setStatus(`Receivers added to map — CSV create error: ${err.message}`);
    } finally {
      hideTransferSpinner();
    }
  }
}

// Accordion toggles for collapsible panels
['rf-params-toggle', 'ia-panel-toggle', 'heatmap-panel-toggle'].forEach(id => {
  const h3 = document.getElementById(id);
  if (h3) h3.addEventListener('click', () => h3.closest('.panel').classList.toggle('collapsed'));
});
