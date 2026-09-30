#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COLLECTOR_DIR=/usr/local/lib/server-security-monitor
SENDER_DIR=/usr/local/lib/ai-executive-security
MONITOR_STATE=/var/lib/server-security-monitor
ALERT_STATE=/var/lib/server-security

getent passwd hermes >/dev/null
install -d -o root -g root -m 0755 "$COLLECTOR_DIR" "$SENDER_DIR"
install -o root -g root -m 0755 "$SOURCE_DIR/server_security_monitor.py" "$COLLECTOR_DIR/server_security_monitor.py"
install -o root -g root -m 0755 "$SOURCE_DIR/../security-alerts/hermes_security_alerts.py" "$SENDER_DIR/hermes_security_alerts.py"

install -d -o root -g root -m 0700 "$MONITOR_STATE"
install -d -o root -g root -m 0755 "$ALERT_STATE"
install -d -o root -g hermes -m 2770 "$ALERT_STATE/outbox"
install -d -o hermes -g hermes -m 0700 "$ALERT_STATE/processing" "$ALERT_STATE/sent" "$ALERT_STATE/failed"

for unit in \
  server-security-monitor.service \
  server-security-monitor.timer \
  server-security-alerts.service \
  server-security-alerts.timer
do
  install -o root -g root -m 0644 "$SOURCE_DIR/$unit" "/etc/systemd/system/$unit"
done

systemctl daemon-reload
systemctl enable --now server-security-monitor.timer server-security-alerts.timer
systemctl start server-security-monitor.service
systemctl start server-security-alerts.service
echo "Server security monitoring is installed and its baseline is active."

