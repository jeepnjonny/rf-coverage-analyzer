# RF Path Coverage Analyzer

A self-hosted web application for analyzing RF signal coverage along a GPS track or between a network of fixed receivers. Upload a KML track and a CSV receiver list, configure RF parameters, and get an interactive color-coded map showing predicted signal coverage based on real terrain elevation data.

![RF Coverage Analyzer screenshot](https://raw.githubusercontent.com/placeholder/screenshot.png)

## Features

- **Track coverage analysis** — color-codes each point along a GPS track by which receiver (if any) provides the best signal
- **Receiver link analysis** — evaluates line-of-sight and estimated RSSI between all pairs of fixed receivers
- **Real terrain elevation** — fetches USGS 1/3 arc-second DEM tiles and caches them locally; no API key required
- **Terrain profiles** — click any receiver link to see a cross-section with Fresnel zone overlay and link budget table
- **Signal hover panel** — move the cursor over the track to see per-receiver RSSI at that point
- **Save / load analyses** — store completed analyses on the server and reload them without re-running
- **In-browser CSV editor** — add, edit, and save receiver lists directly in the file manager
- **Configurable RF parameters** — frequency, vegetation/clutter loss, fade margin, Tx power, antenna gain, receiver sensitivity
- **Multiple base maps** — USGS Topo, USGS Satellite, OpenStreetMap

## Quick install (Debian / Ubuntu server)

```bash
# 1. Clone the repository
git clone https://github.com/jeepnjonny/rf-coverage-analyzer.git
cd rf-coverage-analyzer

# 2. Run the setup script as root
chmod +x setup.sh
sudo ./setup.sh
```

The script installs Python 3, nginx, and rsync; sets up a Python virtual environment; configures nginx on port 80 as the sole site; and starts the app as a systemd service.

After setup, the app is available at:
```
http://<server-ip>/rf-analyzer/index.html
```

### Installing alongside an existing Apache server

If Apache is already running on port 80, use `setup-apache.sh` instead. It adds the app as a configuration fragment so it coexists with whatever Apache is already serving — no existing sites are touched.

```bash
chmod +x setup-apache.sh
sudo ./setup-apache.sh
```

The script enables the required Apache proxy modules (`proxy`, `proxy_http`, `alias`, `headers`, `expires`), drops `apache.conf` into `/etc/apache2/conf-available/`, enables it, and reloads Apache. Gunicorn still runs as the same systemd service on `127.0.0.1:5000`; Apache reverse-proxies to it.

> **SSE note:** `apache.conf` sets `flushpackets=on` on the `/api/analyze` location. Without this, Apache buffers the SSE stream and the map will not update until the analysis finishes.

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

### KML track
Standard KML with a `<LineString>` or `<MultiGeometry>` of `<coordinates>`. Export directly from Google Earth, Garmin BaseCamp, or similar tools. Upload via the **KML Track** button in the sidebar.

### Receiver CSV
```
name,longitude,latitude,height_agl_m,antenna_gain_dbi,tx_power_dbm,enabled
Base Camp,-105.1234,39.5678,5,0,22,1
Relay Ridge,-105.2345,39.6789,3,3,22,1
Summit RX,-105.3456,39.7890,2,0,17,0
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

## RF model

Coverage is computed using a modified **Deygout** knife-edge diffraction model over actual terrain elevation profiles retrieved from the USGS 3DEP dataset. The link budget is:

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
| Reverse proxy | nginx on port 80 |
| Elevation data | USGS 3DEP 1/3 arc-second tiles, cached in `uploads/tiles/` |
| Process manager | systemd |

Analysis results are streamed to the browser via **Server-Sent Events (SSE)** so the map updates in real time as each batch of points is processed.

## Configuration

All RF defaults are set in the sidebar UI and are per-session. Server-side settings (workers, threads, port) are in `rf-coverage-analyzer.service`. nginx settings are in `nginx.conf`.

To adjust Gunicorn concurrency, edit the service file and restart:
```bash
sudo systemctl edit --full rf-coverage-analyzer
# Change --workers and --threads, then:
sudo systemctl restart rf-coverage-analyzer
```

## License

MIT
