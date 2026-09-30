#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=/usr/local/lib/ai-executive-security
STATE_DIR=/var/lib/ai-executive-security
APP_USER=$(systemctl show ai-executive -p User --value)

getent passwd hermes >/dev/null
if [ -z "$APP_USER" ]; then
  echo "The ai-executive service has no dedicated User." >&2
  exit 1
fi
getent passwd "$APP_USER" >/dev/null
install -d -o root -g root -m 0755 "$INSTALL_DIR"
install -o root -g root -m 0755 "$SOURCE_DIR/hermes_security_alerts.py" "$INSTALL_DIR/hermes_security_alerts.py"
install -d -o root -g root -m 0755 "$STATE_DIR"
install -d -o "$APP_USER" -g hermes -m 2770 "$STATE_DIR/outbox"
install -d -o hermes -g hermes -m 0700 "$STATE_DIR/processing" "$STATE_DIR/sent" "$STATE_DIR/failed"
install -o root -g root -m 0644 "$SOURCE_DIR/ai-executive-security-alerts.service" /etc/systemd/system/ai-executive-security-alerts.service
install -o root -g root -m 0644 "$SOURCE_DIR/ai-executive-security-alerts.timer" /etc/systemd/system/ai-executive-security-alerts.timer

install -d -o root -g root -m 0755 /etc/systemd/system/ai-executive.service.d
cat > /etc/systemd/system/ai-executive.service.d/20-security-alerts.conf <<EOF
[Service]
Environment=AI_EXECUTIVE_SECURITY_OUTBOX_DIR=$STATE_DIR/outbox
ReadWritePaths=$STATE_DIR/outbox
EOF
chmod 0644 /etc/systemd/system/ai-executive.service.d/20-security-alerts.conf

systemctl daemon-reload
systemctl enable --now ai-executive-security-alerts.timer
systemctl restart ai-executive
systemctl start ai-executive-security-alerts.service
echo "AI Executive security alerts are installed."
