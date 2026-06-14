#!/usr/bin/env bash
# Self-setup for the home-hub Express server (devices + sensors + automations, :8088).
# Run on the target Ubuntu host from inside this directory (sudo-capable user):
#   ./setup.sh
# Idempotent. Builds the hub and registers it under systemd. No GPU/LLM involved.
# The "emma" voice-assistant path stays dormant: it is gated on USER==='pi', and this unit runs as
# the 'homehub' service user (AWS Polly / vcgencmd are not invoked on a generic host).
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="${HOMEHUB_USER:-homehub}"
UNIT="homehub-server.service"
PORT=8088

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "This installs systemd services — run it on the Ubuntu host, not $(uname -s)."

command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 18+ (e.g. via NodeSource)."
command -v npm  >/dev/null 2>&1 || die "npm not found (comes with Node.js)."

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user '$SERVICE_USER'"
  sudo useradd --system --no-create-home --home-dir "$SERVICE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

[[ -f "$SERVICE_DIR/.env" ]] || warn "No .env present — the hub runs with defaults (port $PORT is hardcoded). Add one for Google Calendar / assistant config if needed."

log "Installing dependencies (npm ci)"
( cd "$SERVICE_DIR" && { npm ci || npm install; } )
log "Building (npm run build)"
( cd "$SERVICE_DIR" && npm run build )

sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$SERVICE_DIR"

log "Installing systemd unit ($UNIT)"
sudo tee "/etc/systemd/system/$UNIT" >/dev/null <<UNITEOF
[Unit]
Description=home-hub Express server (devices + sensors + automations, :${PORT})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${SERVICE_DIR}
EnvironmentFile=-${SERVICE_DIR}/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITEOF
sudo systemctl daemon-reload
sudo systemctl enable --now "$UNIT"

log "Done. Check: systemctl status $UNIT  |  curl localhost:${PORT}/get-devices"
