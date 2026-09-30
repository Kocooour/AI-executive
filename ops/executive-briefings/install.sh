#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=/usr/local/lib/ai-executive-briefings
STATE_DIR=/var/lib/ai-executive-briefings
APP_USER=$(systemctl show ai-executive -p User --value)
[ -n "$APP_USER" ] || { echo "AI Executive service needs a dedicated User." >&2; exit 1; }
getent passwd "$APP_USER" >/dev/null
getent passwd hermes >/dev/null
install -d -o root -g root -m 0755 "$INSTALL_DIR" "$STATE_DIR"
install -o root -g root -m 0755 "$SOURCE_DIR/hermes_executive_briefings.py" "$INSTALL_DIR/hermes_executive_briefings.py"
install -d -o "$APP_USER" -g hermes -m 2770 "$STATE_DIR/outbox"
install -d -o hermes -g hermes -m 0700 "$STATE_DIR/processing" "$STATE_DIR/sent" "$STATE_DIR/failed"
install -o root -g root -m 0644 "$SOURCE_DIR/ai-executive-briefings.service" /etc/systemd/system/
install -o root -g root -m 0644 "$SOURCE_DIR/ai-executive-briefings.timer" /etc/systemd/system/
install -d -o root -g root -m 0755 /etc/systemd/system/ai-executive.service.d
cat > /etc/systemd/system/ai-executive.service.d/30-executive-briefings.conf <<EOF
[Service]
Environment=AI_EXECUTIVE_BRIEFING_OUTBOX_DIR=$STATE_DIR/outbox
ReadWritePaths=$STATE_DIR/outbox
EOF
chmod 0644 /etc/systemd/system/ai-executive.service.d/30-executive-briefings.conf
systemctl daemon-reload
systemctl enable --now ai-executive-briefings.timer
systemctl restart ai-executive
echo "AI Executive briefing delivery is installed."
