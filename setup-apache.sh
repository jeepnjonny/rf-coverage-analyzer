#!/usr/bin/env bash
# RF Coverage Analyzer — install / update script for servers with Apache
# Adds the app alongside whatever Apache is already serving.
# Supports both fresh installs and re-deployments.
# Run from the project root directory:
#   chmod +x setup-apache.sh && sudo ./setup-apache.sh
#
# App will be reachable at:  http://<host>/rf-analyzer/index.html
set -euo pipefail

INSTALL_DIR="/srv/rfanalysis"
SERVICE_NAME="rf-coverage-analyzer"
APACHE_CONF="/etc/apache2/conf-available/$SERVICE_NAME.conf"
APP_URL="http://$(hostname -I | awk '{print $1}')/rf-analyzer/index.html"

echo "=== RF Coverage Analyzer (Apache) — $([ -d "$INSTALL_DIR" ] && echo 'Update' || echo 'Fresh install') ==="

# ── 1. System packages ───────────────────────────────────────────────────────
echo "[1/6] Installing system packages…"
apt-get update -qq
apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    rsync

# ── 2. Sync application code ─────────────────────────────────────────────────
echo "[2/6] Syncing application files to $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"
rsync -a --delete \
    --exclude='uploads/' \
    --exclude='venv/' \
    --exclude='__pycache__/' \
    --exclude='*.pyc' \
    --exclude='.git/' \
    --exclude='.claude/' \
    --exclude='*.egg-info/' \
    . "$INSTALL_DIR/"

# ── 3. Upload / data directories (never overwritten by rsync) ────────────────
echo "[3/6] Creating data directories…"
mkdir -p \
    "$INSTALL_DIR/uploads/kml" \
    "$INSTALL_DIR/uploads/csv" \
    "$INSTALL_DIR/uploads/tiles" \
    "$INSTALL_DIR/uploads/analyses"
chown -R www-data:www-data "$INSTALL_DIR"
chmod -R u=rwX,g=rX,o= "$INSTALL_DIR"
chmod -R u=rwX,g=rwX "$INSTALL_DIR/uploads"

# ── 4. Python virtual environment ────────────────────────────────────────────
echo "[4/6] Setting up Python virtual environment…"
if [ ! -d "$INSTALL_DIR/venv" ]; then
    sudo -u www-data python3 -m venv "$INSTALL_DIR/venv"
fi
sudo -u www-data "$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip
sudo -u www-data "$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"

# ── 5. Apache configuration ──────────────────────────────────────────────────
echo "[5/6] Configuring Apache…"

# Enable required modules (idempotent)
a2enmod proxy proxy_http alias headers expires

# Install the config fragment
cp "$INSTALL_DIR/apache.conf" "$APACHE_CONF"
a2enconf "$SERVICE_NAME"

# Verify config before reloading
apache2ctl configtest
systemctl reload apache2

# ── 6. systemd service ───────────────────────────────────────────────────────
echo "[6/6] Installing and (re)starting systemd service…"
cp "$INSTALL_DIR/$SERVICE_NAME.service" "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setup complete ==="
systemctl status "$SERVICE_NAME" --no-pager -l
echo ""
echo "  Application: $APP_URL"
echo ""
