#!/usr/bin/env bash
# RF Coverage Analyzer — Install Verification Script
# Run as root (or with sudo) on the target server:
#   sudo bash verify.sh
# Exits 0 if all checks pass, 1 if any fail.

INSTALL_DIR="/srv/rfanalysis"
SERVICE_NAME="rf-coverage-analyzer"
FLASK_PORT="5000"
BASE_URL="http://127.0.0.1"

PASS=0; FAIL=0; WARN=0
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[0;33m'; BLD='\033[1m'; RST='\033[0m'

pass() { echo -e "  ${GRN}[PASS]${RST} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}[FAIL]${RST} $1"; ((FAIL++)); }
warn() { echo -e "  ${YLW}[WARN]${RST} $1"; ((WARN++)); }
section() { echo -e "\n${BLD}── $1 ──${RST}"; }

# ── 1. Required files ─────────────────────────────────────────────────────────
section "Installation files"

for f in \
    "$INSTALL_DIR/app.py" \
    "$INSTALL_DIR/requirements.txt" \
    "$INSTALL_DIR/nginx.conf" \
    "$INSTALL_DIR/$SERVICE_NAME.service" \
    "$INSTALL_DIR/static/index.html" \
    "$INSTALL_DIR/static/js/main.js" \
    "$INSTALL_DIR/static/css/style.css"
do
    if [ -f "$f" ]; then pass "$f"; else fail "$f — not found"; fi
done

# ── 2. Data directories ───────────────────────────────────────────────────────
section "Data directories"

for d in \
    "$INSTALL_DIR/uploads/kml" \
    "$INSTALL_DIR/uploads/csv" \
    "$INSTALL_DIR/uploads/tiles" \
    "$INSTALL_DIR/uploads/analyses"
do
    if [ -d "$d" ]; then
        owner=$(stat -c '%U' "$d" 2>/dev/null)
        perms=$(stat -c '%a' "$d" 2>/dev/null)
        if [ "$owner" = "www-data" ]; then
            pass "$d  (owner: $owner, mode: $perms)"
        else
            warn "$d exists but owner is '$owner' (expected www-data)"
        fi
    else
        fail "$d — directory missing"
    fi
done

# ── 3. Python virtual environment ─────────────────────────────────────────────
section "Python virtual environment"

PYTHON="$INSTALL_DIR/venv/bin/python3"
GUNICORN="$INSTALL_DIR/venv/bin/gunicorn"
PIP="$INSTALL_DIR/venv/bin/pip"

if [ -x "$PYTHON" ];   then pass "venv python: $($PYTHON --version 2>&1)";   else fail "venv python not found at $PYTHON"; fi
if [ -x "$GUNICORN" ]; then pass "gunicorn: $($GUNICORN --version 2>&1)"; else fail "gunicorn not found at $GUNICORN"; fi

if [ -x "$PIP" ]; then
    for pkg in flask gunicorn werkzeug Pillow requests; do
        ver=$("$PIP" show "$pkg" 2>/dev/null | awk '/^Version:/{print $2}')
        if [ -n "$ver" ]; then pass "$pkg $ver installed";
        else fail "$pkg — not installed in venv"; fi
    done
fi

# ── 4. systemd service ────────────────────────────────────────────────────────
section "systemd service"

unit_file="/etc/systemd/system/$SERVICE_NAME.service"
if [ -f "$unit_file" ]; then
    pass "Unit file present: $unit_file"
else
    fail "Unit file missing: $unit_file"
fi

enabled=$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null)
case "$enabled" in
    enabled)  pass "Service is enabled (starts on boot)" ;;
    disabled) warn "Service is disabled — will not start on reboot" ;;
    *)        fail "Service not found in systemd (enabled=$enabled)" ;;
esac

active=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null)
case "$active" in
    active)   pass "Service is active (running)" ;;
    activating) warn "Service is still starting up — rerun in a moment" ;;
    *)        fail "Service is not running (state=$active)"
              echo -e "       Last 20 log lines:"
              journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null | sed 's/^/         /'
              ;;
esac

# ── 5. Port binding ───────────────────────────────────────────────────────────
section "Network / port binding"

if command -v ss &>/dev/null; then
    listener=$(ss -tlnp 2>/dev/null | grep ":$FLASK_PORT ")
elif command -v netstat &>/dev/null; then
    listener=$(netstat -tlnp 2>/dev/null | grep ":$FLASK_PORT ")
else
    listener=""
fi

if [ -n "$listener" ]; then
    pass "Gunicorn is listening on port $FLASK_PORT"
else
    fail "Nothing is listening on port $FLASK_PORT"
fi

if ss -tlnp 2>/dev/null | grep -q ':80 '; then
    pass "nginx is listening on port 80"
elif netstat -tlnp 2>/dev/null | grep -q ':80 '; then
    pass "nginx is listening on port 80"
else
    fail "Nothing is listening on port 80"
fi

# ── 6. nginx configuration ────────────────────────────────────────────────────
section "nginx configuration"

nginx_test=$(nginx -t 2>&1)
if echo "$nginx_test" | grep -q "test is successful"; then
    pass "nginx config syntax OK"
else
    fail "nginx config test failed:"
    echo "$nginx_test" | sed 's/^/         /'
fi

SITES_ENABLED="/etc/nginx/sites-enabled/$SERVICE_NAME"
if [ -L "$SITES_ENABLED" ] || [ -f "$SITES_ENABLED" ]; then
    pass "nginx site enabled: $SITES_ENABLED"
else
    fail "nginx site not in sites-enabled: $SITES_ENABLED"
fi

if [ -e "/etc/nginx/sites-enabled/default" ]; then
    warn "Default nginx site is still enabled — may intercept requests"
fi

# ── 7. HTTP smoke tests ───────────────────────────────────────────────────────
section "HTTP smoke tests"

http_check() {
    local label="$1" url="$2" expect_code="$3" grep_body="$4"
    result=$(curl -s -o /tmp/rfv_body -w "%{http_code}" --max-time 8 "$url" 2>/dev/null)
    if [ "$result" = "$expect_code" ]; then
        if [ -n "$grep_body" ]; then
            if grep -q "$grep_body" /tmp/rfv_body 2>/dev/null; then
                pass "$label → HTTP $result, body contains '$grep_body'"
            else
                warn "$label → HTTP $result but body missing '$grep_body'"
            fi
        else
            pass "$label → HTTP $result"
        fi
    else
        fail "$label → expected HTTP $expect_code, got HTTP $result  ($url)"
        if [ -s /tmp/rfv_body ]; then
            head -c 200 /tmp/rfv_body | sed 's/^/         /'
        fi
    fi
}

# Flask direct (bypasses nginx)
http_check "Flask /          (direct)"   "http://127.0.0.1:$FLASK_PORT/"          "200" "RF Path Coverage"
http_check "Flask /api/files (direct)"   "http://127.0.0.1:$FLASK_PORT/api/files" "200" ""

# Via nginx
http_check "nginx /rf-analyzer/index.html"  "$BASE_URL/rf-analyzer/index.html"  "200" "RF Path Coverage"
http_check "nginx /rf-analyzer/ redirect"   "$BASE_URL/rf-analyzer/"            "200" "RF Path Coverage"
http_check "nginx / redirect"               "$BASE_URL/"                        "301" ""
http_check "nginx /static/js/main.js"       "$BASE_URL/static/js/main.js"       "200" "startAnalysis"
http_check "nginx /static/css/style.css"    "$BASE_URL/static/css/style.css"    "200" "app-header"
http_check "nginx /api/files"               "$BASE_URL/api/files"               "200" ""
http_check "nginx /api/analyses"            "$BASE_URL/api/analyses"            "200" ""

rm -f /tmp/rfv_body

# ── 8. Summary ────────────────────────────────────────────────────────────────
echo -e "\n${BLD}══════════════════════════════════════${RST}"
echo -e " PASS: ${GRN}$PASS${RST}   WARN: ${YLW}$WARN${RST}   FAIL: ${RED}$FAIL${RST}"
echo -e "${BLD}══════════════════════════════════════${RST}"

if [ "$FAIL" -gt 0 ]; then
    echo -e "\n${RED}One or more checks failed.${RST} Common fixes:\n"
    echo "  Service not running:  sudo systemctl restart $SERVICE_NAME"
    echo "                        sudo journalctl -u $SERVICE_NAME -n 50"
    echo "  nginx not running:    sudo systemctl restart nginx"
    echo "  Wrong site active:    sudo nginx -t && sudo systemctl reload nginx"
    echo "  Permissions:          sudo chown -R www-data:www-data $INSTALL_DIR/uploads"
    echo "  Missing packages:     cd $INSTALL_DIR && sudo -u www-data venv/bin/pip install -r requirements.txt"
    echo ""
    exit 1
fi

if [ "$WARN" -gt 0 ]; then
    echo -e "\n${YLW}All checks passed with warnings — review items above.${RST}\n"
    exit 0
fi

echo -e "\n${GRN}All checks passed.${RST} App is live at: http://$(hostname -I | awk '{print $1}')/rf-analyzer/index.html\n"
exit 0
