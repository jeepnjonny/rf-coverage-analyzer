#!/usr/bin/env bash
# RF Coverage Analyzer -- one-time initial install
# Run as root (needs sudo to install OS packages and write system config):
#   chmod +x install.sh && sudo ./install.sh
#
# Safe to run from anywhere -- it clones the repo itself into INSTALL_DIR,
# it does not need to be run from inside an existing checkout.
#
# What this does (all of it genuinely requires root):
#   - installs OS packages (python3, nginx, git)
#   - clones the app into INSTALL_DIR and hands ownership to www-data
#   - creates the Python venv and installs dependencies
#   - wires the app into nginx via a snippet + [include] line
#   - installs and starts the systemd service
#   - registers update.sh in cron (as www-data, no root needed after this)
#
# Routine code updates after this point are handled by update.sh, which
# never needs sudo -- see that file and the README for how it works.
#
# Installs the app as a location block inside the nginx server for TARGET_HOST.
# The app is reachable at:  http://TARGET_HOST/rf-analyzer/index.html
#
# NOTE: The app uses top-level paths /static/ and /api/.  Only deploy this
# into a server block whose other locations don't already use those paths
# (e.g. don't share a vhost with CourseSentry, which owns /api/ at its root).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: install.sh must be run as root (sudo ./install.sh)" >&2
    exit 1
fi

INSTALL_DIR="/srv/rfanalysis"
SERVICE_NAME="rf-coverage-analyzer"
SNIPPET="/etc/nginx/snippets/$SERVICE_NAME.conf"
TARGET_HOST="${RF_ANALYZER_HOST:-apps.k7swi.org}"
REPO_URL="${RF_ANALYZER_REPO:-https://github.com/jeepnjonny/rf-coverage-analyzer.git}"
BRANCH="${RF_ANALYZER_BRANCH:-master}"
# Cron schedule for auto-updates, in standard crontab syntax. Set to "off" to
# skip cron registration entirely (manual `sudo -u www-data ./update.sh` only).
CRON_SCHEDULE="${RF_ANALYZER_CRON:-*/15 * * * *}"
APP_URL="http://${TARGET_HOST}/rf-analyzer/index.html"

echo "=== RF Coverage Analyzer -- initial install ==="

# ── 1. System packages ───────────────────────────────────────────────────────
echo "[1/7] Installing system packages..."
apt-get update -qq
apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    nginx git cron

# ── 2. Fetch application code ────────────────────────────────────────────────
# INSTALL_DIR *is* the git working copy -- update.sh later just `git pull`s
# here directly. nginx only ever serves INSTALL_DIR/static/ (see nginx.conf),
# never the directory root, so having .git alongside the app is not web-exposed.
echo "[2/7] Fetching application code into $INSTALL_DIR..."
if [ -d "$INSTALL_DIR/.git" ]; then
    echo "  $INSTALL_DIR is already a git checkout -- leaving source as-is"
    echo "  (run update.sh, not install.sh, to pull code changes)"
elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    echo "ERROR: $INSTALL_DIR exists, is non-empty, and is not a git checkout." >&2
    echo "       Refusing to overwrite it. Move it aside and re-run, e.g.:" >&2
    echo "         sudo mv $INSTALL_DIR ${INSTALL_DIR}.bak" >&2
    exit 1
else
    mkdir -p "$INSTALL_DIR"
    chown www-data:www-data "$INSTALL_DIR"
    sudo -u www-data git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# ── 3. Upload / data directories (never touched by git) ──────────────────────
echo "[3/7] Creating data directories..."
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
echo "[4/7] Setting up Python virtual environment..."
if [ ! -d "$INSTALL_DIR/venv" ] || ! sudo -u www-data "$INSTALL_DIR/venv/bin/python" -c "import pip" 2>/dev/null; then
    rm -rf "$INSTALL_DIR/venv"
    sudo -u www-data python3 -m venv "$INSTALL_DIR/venv"
fi
sudo -u www-data "$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip
sudo -u www-data "$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"

# ── 5. nginx snippet ─────────────────────────────────────────────────────────
echo "[5/7] Configuring nginx..."
mkdir -p /etc/nginx/snippets
cp "$INSTALL_DIR/nginx.conf" "$SNIPPET"

# Find the nginx server config that already handles TARGET_HOST.
# Never fall back to "default" or "first enabled site" -- a wrong guess here
# means this snippet's top-level /api/ and /static/ locations silently
# shadow another app's routes on whatever vhost gets picked.
NGINX_SITE=""
# `|| true` is required: grep exits 1 when no site matches, which is the
# normal "no vhost yet -- create one" case handled below. Under `set -e
# -o pipefail` an unguarded grep failure here would abort the whole script
# silently (stderr is redirected to /dev/null) before that fallback ever runs.
MATCH=$(grep -rl "server_name[[:space:]].*${TARGET_HOST}" /etc/nginx/sites-enabled/ 2>/dev/null | head -1) || true
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
echo "[6/7] Installing and starting systemd service..."
cp "$INSTALL_DIR/$SERVICE_NAME.service" "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# Record what commit is now actually running, so the first cron-triggered
# update.sh run doesn't send a redundant reload for code already live.
# (Must be written as www-data, not root -- update.sh runs as www-data and
# needs write access to this file after every future reload.)
sudo -u www-data sh -c "git -C '$INSTALL_DIR' rev-parse HEAD > '$INSTALL_DIR/.last_reload_sha'"

# ── 7. Auto-update cron job ──────────────────────────────────────────────────
echo "[7/7] Registering auto-update cron job..."
chmod +x "$INSTALL_DIR/update.sh"
CRON_FILE="/etc/cron.d/$SERVICE_NAME-update"
if [ "$CRON_SCHEDULE" = "off" ]; then
    rm -f "$CRON_FILE"
    echo "  RF_ANALYZER_CRON=off -- no cron job installed (run update.sh manually)"
else
    touch /var/log/rf-coverage-update.log
    chown www-data:www-data /var/log/rf-coverage-update.log
    cat > "$CRON_FILE" << CRONEOF
# Auto-updates RF Coverage Analyzer from git. Installed by install.sh --
# edit the schedule here directly, or re-run install.sh with RF_ANALYZER_CRON set.
# Runs as www-data (already owns $INSTALL_DIR) so no sudo/root is needed.
$CRON_SCHEDULE www-data $INSTALL_DIR/update.sh >> /var/log/rf-coverage-update.log 2>&1
CRONEOF
    chmod 644 "$CRON_FILE"
    systemctl reload cron 2>/dev/null || systemctl restart cron
    echo "  Installed $CRON_FILE ($CRON_SCHEDULE)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "=== Install complete ==="
systemctl status "$SERVICE_NAME" --no-pager -l
echo ""
echo "  Application: $APP_URL"
echo "  Code updates from here on: update.sh (auto via cron, or run manually as www-data)"
echo ""
