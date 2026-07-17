#!/usr/bin/env bash
# RF Coverage Analyzer -- unprivileged auto-update
#
# Run as www-data (the same user that owns INSTALL_DIR and runs gunicorn),
# either from cron -- installed automatically by install.sh -- or by hand:
#   sudo -u www-data ./update.sh
#
# Deliberately does NOT use sudo anywhere:
#   - www-data already owns this checkout, so `git pull` and `pip install`
#     into the venv need no elevated permissions
#   - the app is reloaded by sending SIGHUP to gunicorn's own master process
#     (same UID signalling its own process -- always allowed), which starts
#     fresh workers that re-import app code from disk and gracefully retires
#     the old ones. No `systemctl restart` / root required.
#
# nginx config and the systemd unit itself are NOT touched here -- those
# genuinely need root. If this script notices either changed upstream, it
# deploys the code anyway but prints a warning telling an admin to re-run
# `sudo ./install.sh` to pick up the infra change.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$SCRIPT_DIR"
BRANCH="${RF_ANALYZER_BRANCH:-master}"
PIDFILE="$INSTALL_DIR/gunicorn.pid"
LOCKFILE="/tmp/rf-coverage-analyzer-update.lock"
# Tracks the last commit gunicorn was actually reloaded with, separately from
# git HEAD -- if a SIGHUP reload fails (e.g. gunicorn briefly down), HEAD is
# already at the new commit on the next run, so comparing only HEAD vs. the
# remote would wrongly think there's nothing left to do and stop retrying.
LAST_RELOAD_FILE="$INSTALL_DIR/.last_reload_sha"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Prevent overlapping runs (e.g. a slow update still going when cron fires again)
exec 200>"$LOCKFILE"
if ! flock -n 200; then
    log "Another update is already running -- exiting"
    exit 0
fi

cd "$INSTALL_DIR"

if [ ! -d .git ]; then
    log "ERROR: $INSTALL_DIR is not a git checkout -- run install.sh first" >&2
    exit 1
fi

# Never touch a working tree with local edits -- could be an admin mid-debug.
if [ -n "$(git status --porcelain)" ]; then
    log "ERROR: $INSTALL_DIR has local changes -- refusing to update." >&2
    log "       Investigate/stash them, then re-run: git status" >&2
    exit 1
fi

git fetch --quiet origin "$BRANCH"
REMOTE=$(git rev-parse "origin/$BRANCH")
LAST_RELOAD=$(cat "$LAST_RELOAD_FILE" 2>/dev/null || echo "")

if [ "$(git rev-parse HEAD)" = "$REMOTE" ] && [ "$LAST_RELOAD" = "$REMOTE" ]; then
    exit 0
fi

LOCAL=$(git rev-parse HEAD)
if [ "$LOCAL" != "$REMOTE" ]; then
    log "Updating $BRANCH: $(git rev-parse --short "$LOCAL") -> $(git rev-parse --short "$REMOTE")"

    CHANGED_FILES=$(git diff --name-only "$LOCAL" "$REMOTE")

    if ! git merge --ff-only "origin/$BRANCH"; then
        log "ERROR: fast-forward merge failed (local history has diverged)." >&2
        log "       This needs manual intervention -- inspect $INSTALL_DIR on the server." >&2
        exit 1
    fi

    if echo "$CHANGED_FILES" | grep -qE '^(nginx\.conf|rf-coverage-analyzer\.service|install\.sh)$'; then
        log "WARNING: nginx.conf / systemd unit / install.sh changed upstream."
        log "         This deploy only updates app code -- re-run 'sudo ./install.sh' to apply it."
    fi

    if echo "$CHANGED_FILES" | grep -q '^requirements\.txt$'; then
        log "requirements.txt changed -- reinstalling dependencies"
        "$INSTALL_DIR/venv/bin/pip" install --quiet -r requirements.txt
    fi
else
    log "HEAD already at $(git rev-parse --short "$REMOTE") -- retrying reload from a previous failed attempt"
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill -HUP "$(cat "$PIDFILE")"
    echo "$REMOTE" > "$LAST_RELOAD_FILE"
    log "Sent SIGHUP to gunicorn (pid $(cat "$PIDFILE")) -- workers reloading with new code"
else
    log "WARNING: no running gunicorn found at $PIDFILE -- service was NOT reloaded." >&2
    log "         Code is updated on disk but the app is still serving the old version." >&2
    log "         Will retry the reload on the next run." >&2
    exit 1
fi

log "Update complete: now at $(git rev-parse --short HEAD)"
