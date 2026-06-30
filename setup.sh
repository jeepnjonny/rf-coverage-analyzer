#!/usr/bin/env bash
# RF Coverage Analyzer -- install / update script
# Supports both fresh installs and re-deployments.
# Run from the project root directory:
#   chmod +x setup.sh && sudo ./setup.sh
#
# Installs the app as a location block inside the nginx server for TARGET_HOST.
# The app is reachable at:  http://TARGET_HOST/rf-analyzer/index.html
#
# NOTE: The app uses top-level paths /static/ and /api/.  Only deploy this
# into a server block whose other locations don't already use those paths
# (e.g. don't share a vhost with CourseSentry, which owns /api/ at its root).
set -euo pipefail

INSTALL_DIR="/srv/rfanalysis"
SERVICE_NAME="rf-coverage-analyzer"
SNIPPET="/etc/nginx/snippets/$SERVICE_NAME.conf"
TARGET_HOST="${RF_ANALYZER_HOST:-apps.k7swi.org}"
APP_URL="http://${TARGET_HOST}/rf-analyzer/index.html"

echo "=== RF Coverage Analyzer -- $([ -d "$INSTALL_DIR" ] && echo 'Update' || echo 'Fresh install') ==="

# ── 1. System packages ───────────────────────────────────────────────────────
echo "[1/6] Installing system packages..."
apt-get update -qq
apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    nginx rsync

# ── 2. Sync application code ─────────────────────────────────────────────────
# rsync copies only source files; uploads/ (tiles, KML, CSV, elevation cache)
# is preserved on re-deploy so cached terrain data is not lost.
echo "[2/6] Syncing application files to $INSTALL_DIR..."
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
echo "[3/6] Creating data directories..."
mkdir -p \
    "$INSTALL_DIR/uploads/kml" \
    "$INSTALL_DIR/uploads/csv" \
    "$INSTALL_DIR/uploads/tiles" \
    "$INSTALL_DIR/uploads/analyses"
chown -R www-data:www-data "$INSTALL_DIR"
chmod -R u=rwX,g=rX,o= "$INSTALL_DIR"
# uploads needs write access for www-data at runtime
chmod -R u=rwX,g=rwX "$INSTALL_DIR/uploads"

# ── 4. Python virtual environment ────────────────────────────────────────────
echo "[4/6] Setting up Python virtual environment..."
if [ ! -d "$INSTALL_DIR/venv" ] || ! sudo -u www-data "$INSTALL_DIR/venv/bin/python" -c "import pip" 2>/dev/null; then
    rm -rf "$INSTALL_DIR/venv"
    sudo -u www-data python3 -m venv "$INSTALL_DIR/venv"
fi
sudo -u www-data "$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip
sudo -u www-data "$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"

# ── 5. nginx snippet ─────────────────────────────────────────────────────────
echo "[5/6] Configuring nginx..."
mkdir -p /etc/nginx/snippets
cp "$INSTALL_DIR/nginx.conf" "$SNIPPET"

# Find the nginx server config that already handles TARGET_HOST.
# Never fall back to "default" or "first enabled site" -- a wrong guess here
# means this snippet's top-level /api/ and /static/ locations silently
# shadow another app's routes on whatever vhost gets picked.
NGINX_SITE=""
MATCH=$(grep -rl "server_name[[:space:]].*${TARGET_HOST}" /etc/nginx/sites-enabled/ 2>/dev/null | head -1)
if [ -n "$MATCH" ]; then
    NGINX_SITE="$(realpath "$MATCH")"
fi

if [ -z "$NGINX_SITE" ]; then
    # No existing server block for this host -- create one
    NGINX_SITE="/etc/nginx/sites-available/${TARGET_HOST}"
    cat > "$NGINX_SITE" << SITEOF
server {
    listen 80;
    listen [::]:80;
    server_name ${TARGET_HOST};
}
SITEOF
    ln -sf "$NGINX_SITE" "/etc/nginx/sites-enabled/${TARGET_HOST}"
    echo "  Created site for ${TARGET_HOST} at $NGINX_SITE"
fi

# Inject the include line inside the server block if not already present
if grep -q "$SERVICE_NAME" "$NGINX_SITE"; then
    echo "  Include already present in $NGINX_SITE -- skipping injection"
else
    # Insert 'include snippets/<name>.conf;' before the last closing brace
    python3 - "$NGINX_SITE" "$SERVICE_NAME" << 'PYEOF'
import re, sys
path, svc = sys.argv[1], sys.argv[2]
text = open(path).read()
include_line = '    include snippets/%s.conf;' % svc
# Match the final closing brace (and any trailing whitespace) at end of file
text = re.sub(r'\n\}(\s*)$', '\n%s\n}\n' % include_line, text)
open(path, 'w').write(text)
print('  Injected include into %s' % path)
PYEOF
fi

nginx -t
systemctl reload nginx

# ── 6. systemd service ───────────────────────────────────────────────────────
echo "[6/6] Installing and (re)starting systemd service..."
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
