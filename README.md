# RF Path Coverage Analyzer

A self-hosted web application for analyzing RF signal coverage along a GPS track or between a network of fixed receivers. Upload a KML/GPX track and a CSV receiver list, configure RF parameters, and get an interactive color-coded map showing predicted signal coverage based on real terrain elevation data.

**Live demo:** [apps.k7swi.org/rf-analyzer/index.html](https://apps.k7swi.org/rf-analyzer/index.html)

Heat map for one or more sites
![Heat Map](Images/Screenshot%202026-07-06%20165906.png)

Track coverage analysis
![Coverage Analysis](Images/Screenshot%202026-07-06%20170112.png)

## Features

### Coverage analysis
- **Track coverage analysis** — color-codes each point along a GPS track by which receiver (if any) provides the best signal
- **Receiver link analysis** — evaluates line-of-sight and estimated RSSI between all pairs of fixed receivers, with a terrain profile / Fresnel zone view for any link
- **Area coverage heat map** — shows network coverage across the currently visible map area (independent of any loaded track), rendered as true-footprint grid cells anchored to a fixed lat/lon lattice so results stay consistent across pans and zooms. Choose from five resolutions (Fast 400 m → Ultra 25 m); cells are colored by signal margin above threshold in dB bands (weak / moderate / strong)
- **Link coverage map** — right-click any receiver to draw its radio horizon: a circular grid of reachable cells at a configurable AGL and radius, with terrain-blocked cells hidden
- **Test a location** — right-click anywhere on the map to test coverage from a temporary transmitter, without adding it to the receiver list; reports coverage % and the longest remaining gap
- **Signal hover panel & cursor info bar** — move the cursor over the track or heat map to see per-receiver RSSI, elevation, and predicted heat map signal at that point

### Infrastructure Advisor
- Suggests new receiver sites along a loaded track to close coverage gaps, ranking candidates from four pools: road-adjacent points, hike-accessible hilltops, on-route waypoints, and fine-grained infill around under-covered "hot zones"
- Two placement modes — **WIDE1 fill-in** (favors road/short-hike access) and **WIDE2 backbone** (favors commanding hilltop elevation)
- Configurable by max walk distance from a road, target coverage %, minimum per-site contribution, max sites to find, and whether to account for existing receivers or include OSM foot trails as candidates
- Live map visualization of each pipeline step, with results importable straight into the receiver list

### APRS chain mode
- Optional mode that requires the *full* relay path to be viable — tracker → WIDE1 fill-in → WIDE2/iGate backbone — not just a single hop
- Driven by a `role` column in the receiver CSV (`wide1`, `wide2`, `igate`, `meshtastic`); Infrastructure Advisor and the heat map apply chain-aware scoring automatically once a backbone receiver is loaded

### Data & workflow
- **Real terrain elevation** — AWS Terrarium elevation tiles (~9 m resolution) as the primary source, with OpenTopoData SRTM30m and USGS EPQS as automatic fallbacks; all tiles/points are cached to disk, no API key required
- **Save / load analyses** — store completed analyses on the server and reload them without re-running
- **In-browser CSV editor** — add, edit, and save receiver lists directly in the file manager; right-click a receiver marker to edit it, test it solo, or generate its link coverage map
- **Configurable RF parameters** — frequency, vegetation/clutter loss, fade margin, tracker Tx power/gain, receiver sensitivity, max practical range
- **Multiple base maps** — USGS Topo, USGS Satellite, OpenStreetMap
- Every analysis (track coverage, links, heat map, link coverage, test-location, advisor) streams results to the browser live via Server-Sent Events, so the map updates as each batch completes and long runs can be watched in progress

## Quick install (Debian / Ubuntu server)

```bash
# 1. Clone the repository
git clone https://github.com/jeepnjonny/rf-coverage-analyzer.git
cd rf-coverage-analyzer

# 2. Run the setup script as root
chmod +x setup.sh
sudo ./setup.sh
```

The script installs Python 3, nginx, and rsync; sets up a Python virtual environment; installs the app as a set of `location` blocks inside nginx's existing default server; and starts the app as a systemd service.

After setup, the app is available at:
```
http://<server-ip>/rf-analyzer/index.html
```

The setup script installs `nginx.conf` as `/etc/nginx/snippets/rf-coverage-analyzer.conf` and injects `include snippets/rf-coverage-analyzer.conf;` into the active nginx server block automatically. On re-deploy (`git pull && sudo ./setup.sh`) the injection is skipped if already present.

> **Path note:** The app uses top-level paths `/static/` and `/api/`. If your nginx server already serves content at those paths they will conflict.

## Verify the installation

```bash
sudo bash verify.sh
```

Checks services, port bindings, nginx config, directory permissions, and HTTP endpoints. Prints PASS / WARN / FAIL for each item with corrective hints for any failures.

## Update an existing install

Re-run `setup.sh` from the cloned repo. It uses `rsync --delete` to sync code files while preserving `uploads/` (cached elevation tiles, KML/CSV files, saved analyses).

```bash
git pull
sudo ./setup.sh
```

## Input file formats

### Track file
KML, KMZ, or GPX. KML/KMZ tracks use a `<LineString>` or `<MultiGeometry>` of `<coordinates>`; GPX tracks (`<trk>`) and routes (`<rte>`) are both supported. Export directly from Google Earth, Garmin BaseCamp, or similar tools. Upload via the **Track File** button in the sidebar.

### Receiver CSV
```
name,longitude,latitude,height_agl_m,antenna_gain_dbi,tx_power_dbm,enabled,role
Base Camp,-105.1234,39.5678,5,0,22,1,igate
Relay Ridge,-105.2345,39.6789,3,3,22,1,wide2
Summit RX,-105.3456,39.7890,2,0,17,0,wide1
```

| Column | Description |
|---|---|
| `name` | Display name (shown on map and in results) |
| `longitude` | Decimal degrees, WGS-84 |
| `latitude` | Decimal degrees, WGS-84 |
| `height_agl_m` | Antenna height above ground level, metres |
| `antenna_gain_dbi` | Receiver antenna gain, dBi |
| `tx_power_dbm` | Receiver transmit power (for inter-receiver link analysis), dBm |
| `enabled` | `1` = include in analysis, `0` = skip |
| `role` | Optional: `wide1`, `wide2`, `igate`, or `meshtastic` — used by APRS chain mode and Infrastructure Advisor to identify backbone-capable receivers |

## RF model

Coverage is computed using a modified **Deygout** knife-edge diffraction model (ITU-R P.526 v-parameter) over actual terrain elevation profiles, with earth curvature applied via a 4/3 effective-radius bulge. The link budget is:

```
RSSI = Tx_power + Tx_gain + Rx_gain − FSPL − diffraction_loss − vegetation_loss
```

A point is considered **covered** when `RSSI ≥ receiver_sensitivity + fade_margin`.

Track segments are colored:
- **Receiver color** — covered by that receiver (best RSSI wins)
- **Red** — hard blocked (terrain/vegetation attenuates signal below threshold regardless of fade margin)
- **Dark blue-grey** — soft fade (signal exists but is below the fade margin threshold)

## Architecture

| Component | Details |
|---|---|
| Backend | Python / Flask, served by Gunicorn (`gthread` worker class) |
| Frontend | Vanilla JS + Leaflet.js, no build step |
| Reverse proxy | nginx (location blocks inside existing server) |
| Elevation data | AWS Terrarium RGB tiles (primary), OpenTopoData SRTM30m and USGS EPQS (fallbacks); cached in `uploads/tiles/` |
| Parallelism | `ProcessPoolExecutor` for CPU-bound RF scoring, `ThreadPoolExecutor` for tile prefetch / I/O, NumPy for vectorized grid and terrain math |
| Process manager | systemd |

Analysis results are streamed to the browser via **Server-Sent Events (SSE)** so the map updates in real time as each batch of points is processed.

## Configuration

All RF defaults are set in the sidebar UI and are per-session. Server-side settings (workers, threads, port) are in `rf-coverage-analyzer.service`. nginx location settings are in `nginx.conf` (installed to `/etc/nginx/snippets/rf-coverage-analyzer.conf`).

To adjust Gunicorn concurrency, edit the service file and restart:
```bash
sudo systemctl edit --full rf-coverage-analyzer
# Change --workers and --threads, then:
sudo systemctl restart rf-coverage-analyzer
```

## License

Copyright (C) 2026 jeepnjonny

Licensed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version of this app as a network service, you must make your modified source available to its users.
