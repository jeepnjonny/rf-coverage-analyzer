/* =========================================================
   RF Path Coverage Analyzer — Frontend
   ========================================================= */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RX_COLORS = [
  '#e63946', '#2196f3', '#4caf50', '#ff9800',
  '#9c27b0', '#00bcd4', '#ffeb3b', '#f06292',
  '#8bc34a', '#ff5722',
];

const CSV_COLS    = ['name','longitude','latitude','height_agl_m','antenna_gain_dbi','tx_power_dbm','enabled'];
const COORD_DP    = 6;   // decimal places — matches server _rc()

function rc(v) { return parseFloat(v.toFixed(COORD_DP)); }

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

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${name}`));

  // Redraw canvas when profile tab becomes visible
  if (name === 'profile' && state.currentProfileData) {
    drawProfile(state.currentProfileData, document.getElementById('profile-canvas'));
  }
}

// ---------------------------------------------------------------------------
// Cursor info bar
// ---------------------------------------------------------------------------

let _elevTimer       = null;
let _signalHideTimer = null;
const _elevMemo = {};   // simple memo: "lat,lon" -> elevation_m

map.on('mousemove', e => {
  const lat = rc(e.latlng.lat);
  const lon = rc(e.latlng.lng);
  onCursorMove(lat, lon);
});
map.on('mouseout', () => {
  document.getElementById('info-gps').textContent    = '—';
  document.getElementById('info-elev').textContent   = '—';
  document.getElementById('info-signal').textContent = '—';
  document.getElementById('info-signal').style.color = '';
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
      sigEl.style.color = RX_COLORS[nr.best_rx_idx % RX_COLORS.length];
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
    const name  = rx?.name || (rxIdx >= 0 ? `RX${rxIdx + 1}` : 'RX?');
    const color = rxIdx >= 0 ? RX_COLORS[rxIdx % RX_COLORS.length] : '#888';

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

function findNearestResult(lat, lon) {
  if (!state.pathResults.length) return null;
  let best = null, bestD = Infinity;
  for (const r of state.pathResults) {
    const d = (r.lat - lat) ** 2 + (r.lon - lon) ** 2;
    if (d < bestD) { bestD = d; best = r; }
  }
  // Only show if cursor is within ~500 m (≈ 0.005°)
  return bestD < 2.5e-5 ? best : null;
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
      html += `<div class="fm-kml-info-row"><span class="fm-kml-info-label">Name</span><span>${ls.name}</span></div>`;
      html += `<div class="fm-kml-info-row"><span class="fm-kml-info-label">Points</span><span>${ls.point_count.toLocaleString()}</span></div>`;
      if (!track.error) {
        html += `<div class="fm-kml-info-row"><span class="fm-kml-info-label">Bounds SW</span><span>${track.bounds[0][0].toFixed(5)}, ${track.bounds[0][1].toFixed(5)}</span></div>`;
        html += `<div class="fm-kml-info-row"><span class="fm-kml-info-label">Bounds NE</span><span>${track.bounds[1][0].toFixed(5)}, ${track.bounds[1][1].toFixed(5)}</span></div>`;
      }
      html += '</div>';
    } else {
      // Multiple LineStrings — radio group
      info.linestrings.forEach((ls, i) => {
        html += `<label class="fm-track-radio">
          <input type="radio" name="fm-track-sel" value="${ls.name}" ${i === 0 ? 'checked' : ''}/>
          <span>${ls.name}</span>
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
          <span class="fm-pm-name">${pm.name || '(unnamed)'}</span>
          <span class="fm-pm-coords">${pm.lat.toFixed(4)}, ${pm.lon.toFixed(4)}</span>
        </label>`;
      });
      html += '</div>';

      const defName = name.replace(/\.(kml|gpx)$/i, '') + '-receivers.csv';
      html += `<div class="fm-save-rx-row">
        <input id="fm-rx-csv-name" class="ctrl-input" type="text" value="${defName}" />
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
    const res  = await fetch(`/api/csv/${encodeURIComponent(name)}`);
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
    const res  = await fetch(`/api/csv/${encodeURIComponent(name)}`);
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

function _rxTooltip(rx, i) {
  const name    = rx.name || `RX${i + 1}`;
  const enabled = _rxEnabled(rx);
  const badge   = enabled ? '' : '<br><span style="color:#e05252;font-size:10px">⊘ disabled — excluded from analysis</span>';
  return `<b>${name}</b>${badge}<br>${rx.height_agl_m || 0} m AGL · ${rx.antenna_gain_dbi || 0} dBi gain<br><span style="color:#7a82a0;font-size:10px">drag to reposition</span>`;
}

// Create and add a single receiver marker at index i (no bounds change)
function _addRxMarker(rx, i) {
  const lat      = parseFloat(rx.latitude);
  const lon      = parseFloat(rx.longitude);
  const color    = RX_COLORS[i % RX_COLORS.length];
  const disabled = !_rxEnabled(rx);
  const icon  = L.divIcon({
    className:     '',
    html:          `<div class="rx-marker${disabled ? ' rx-disabled' : ''}" id="rx-dot-${i}" style="background:${color}"></div>`,
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

function updateLegend() { /* legend removed — receivers identified by marker color */ }

function checkReady() {
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

// ---------------------------------------------------------------------------
// Map PNG download
// ---------------------------------------------------------------------------

document.getElementById('download-map-btn').addEventListener('click', async () => {
  const btn = document.getElementById('download-map-btn');
  btn.textContent = '…';
  btn.disabled = true;
  try {
    const canvas = await html2canvas(document.getElementById('map'), {
      useCORS:    true,
      allowTaint: false,
      logging:    false,
      scale:      window.devicePixelRatio || 1,
    });
    const a = document.createElement('a');
    a.download = `rf-coverage-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  } catch (err) {
    alert(`Screenshot failed: ${err.message}\nTry switching to USGS Topo basemap (supports CORS).`);
  } finally {
    btn.textContent = '⬇ PNG';
    btn.disabled = false;
  }
});

function startAnalysis(mode, opts = {}) {
  if (state.analysisRunning) return;

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
  };

  checkReady();
  showProgress(true);
  setProgress('Starting…', 0);
  setStatus('');

  const params = {
    kml_file:        state.kmlFile,
    csv_file:        state.csvFile,
    // Send receivers directly so the server always uses the live UI state
    // (enabled flags, dragged positions) without requiring an explicit CSV save first.
    receivers:       state.receivers,
    freq_mhz:        state.lastFreqMhz,
    tx_power_dbm:    parseFloat(document.getElementById('tx-power').value),
    tx_gain_dbi:     parseFloat(document.getElementById('tx-gain').value),
    sensitivity_dbm: parseFloat(document.getElementById('rx-sens').value),
    veg_type:        document.getElementById('veg-loss').value,
    fade_margin_db:  parseFloat(document.getElementById('fade-margin').value) || 0,
    mode,
  };

  // Segment drawing state
  let segColor = null;
  let segPts   = [];
  const flushSeg = nextPt => {
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

      evt.points.forEach(pt => {
        // Store for cursor hover RSSI
        state.pathResults.push(pt);

        // covered → receiver colour  |  blocked (terrain/veg) → red  |  faded (below threshold) → grey
        const color  = pt.coverage   ? RX_COLORS[pt.best_rx_idx % RX_COLORS.length]
                     : pt.hard_fail  ? '#c0392b'   // hard blocked — bright red
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
      const color = RX_COLORS[evt.rx1_idx % RX_COLORS.length];
      const pl = L.polyline(
        [[parseFloat(rx1.latitude), parseFloat(rx1.longitude)],
         [parseFloat(rx2.latitude), parseFloat(rx2.longitude)]],
        { color, weight: 2.5, opacity: 0.75, rx1_idx: evt.rx1_idx, rx2_idx: evt.rx2_idx }
      );
      pl.bindTooltip(
        `${rx1.name} ↔ ${rx2.name}<br>${evt.rssi} dBm · ${evt.dist_km} km · diff: ${evt.diff_db} dB`,
        { sticky: true }
      );
      pl.on('click', () => showTerrainProfile(rx1, rx2, evt.rx1_idx, evt.rx2_idx));
      pl.addTo(interRxLayer);
      break;
    }

    case 'complete':
      ctx.flushSeg(null);
      if (evt.mode !== 'links') renderResults(evt.stats, evt.total_coverage_pct);
      setProgress('Complete', 100);
      setStatus(evt.mode === 'links'
        ? 'Receiver link analysis complete.'
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
    path_results:       state.pathResults,
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
    const color  = pt.coverage   ? RX_COLORS[pt.best_rx_idx % RX_COLORS.length]
                 : pt.hard_fail  ? '#c0392b'
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
    const color = RX_COLORS[evt.rx1_idx % RX_COLORS.length];
    const pl = L.polyline(
      [[parseFloat(rx1.latitude), parseFloat(rx1.longitude)],
       [parseFloat(rx2.latitude), parseFloat(rx2.longitude)]],
      { color, weight: 2.5, opacity: 0.75, rx1_idx: evt.rx1_idx, rx2_idx: evt.rx2_idx }
    );
    pl.bindTooltip(
      `${rx1.name} ↔ ${rx2.name}<br>${evt.rssi} dBm · ${evt.dist_km} km · diff: ${evt.diff_db} dB`,
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
      <div class="fm-saved-item-name">${a.name || 'Unnamed'}</div>
      <div class="fm-saved-item-meta">
        <span>${date}</span>
        ${modeBadge}${covBadge}
        ${a.kml_file ? `<span class="fm-saved-item-badge">📍 ${a.kml_file}</span>` : ''}
        ${a.csv_file ? `<span class="fm-saved-item-badge">📋 ${a.csv_file}</span>` : ''}
      </div>`;
    div.addEventListener('click', () => {
      fm.selAnalysis = a.id;
      renderFmSavedList();
      _setSavedBtns(true);
    });
    el.appendChild(div);
  });
}

function _setSavedBtns(enabled) {
  document.getElementById('fm-saved-load-btn').disabled   = !enabled;
  document.getElementById('fm-saved-delete-btn').disabled = !enabled;
}

async function loadSavedAnalysis() {
  if (!fm.selAnalysis) return;
  showTransferSpinner('Loading analysis…');
  try {
    const res  = await fetch(`/api/analyses/${encodeURIComponent(fm.selAnalysis)}`);
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

    // ── Restore app state ───────────────────────────────────
    state.kmlFile            = data.kml_file || null;
    state.csvFile            = data.csv_file || null;
    state.kmlCoords          = data.kml_coords || [];
    state.lastFreqMhz        = p.freq_mhz || 915;
    state.receivers          = (data.receivers || []).map(r => ({ enabled: '1', ...r }));
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
    closeFmModal();
    setStatus(`Loaded "${data.name || 'analysis'}".`);
  } catch (err) {
    alert(`Load failed: ${err.message}`);
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

function renderResults(stats, totalPct) {
  const tbody = document.getElementById('results-tbody');
  const tfoot = document.getElementById('results-tfoot');
  tbody.innerHTML = '';
  tfoot.innerHTML = '';

  stats.forEach((s, i) => {
    const color = RX_COLORS[(s.color_idx ?? i) % RX_COLORS.length];
    const tr    = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="rx-swatch" style="background:${color}"></span>${s.name}</td>
      <td>${s.coverage_pct}%</td>
      <td>${s.avg_rssi !== null ? s.avg_rssi + ' dBm' : '—'}</td>
      <td>
        <div class="cov-bar-wrap">
          <div class="cov-bar-fill" style="width:${s.coverage_pct}%;background:${coverageColor(s.coverage_pct)}"></div>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });

  const tf = document.createElement('tr');
  tf.innerHTML = `<td>Total Course Coverage</td><td>${totalPct}%</td><td>—</td>
    <td><div class="cov-bar-wrap"><div class="cov-bar-fill"
      style="width:${totalPct}%;background:${coverageColor(totalPct)}"></div></div></td>`;
  tfoot.appendChild(tf);

  document.getElementById('results-empty').classList.add('hidden');
  document.getElementById('results-scroll').classList.remove('hidden');
  switchTab('coverage');
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
    data._rx1Color = RX_COLORS[rx1Idx % RX_COLORS.length];
    data._rx2Color = RX_COLORS[rx2Idx % RX_COLORS.length];
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
    data._rx2Color    = RX_COLORS[rxIdx % RX_COLORS.length];
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
    const color = idx >= 0 ? RX_COLORS[idx % RX_COLORS.length] : '#888';
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
        // Keep file manager editor in sync
        fm.editorFile = state.csvFile;
        fm.editorRows = state.receivers.map(r => ({ ...r }));
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

// Save-analysis row (shown after a successful analysis)
document.getElementById('save-analysis-btn').addEventListener('click',  saveAnalysis);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

refreshFmFileLists();
