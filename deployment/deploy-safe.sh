#!/usr/bin/env bash
# Lumi production deployment. Execute a reviewed commit's script as root inside tmux.
set -Eeuo pipefail
umask 022
APP=/opt/ai-executive
DATA=/var/lib/ai-executive
ENVFILE=/etc/ai-executive/ai-executive.env
BACKUP_DIR=/var/backups/ai-executive
SERVICE=ai-executive
HTTPS_BASE=https://vm13861.tail412944.ts.net:8443
TARGET="${1:-}"
PREV=""
BACKUP=""
STOPPED=0
CHANGED=0

die() { echo "STOP: $*" >&2; exit 1; }

# A root build can leave .next/BUILD_ID mode 0600. Never make the build world-writable.
fix_build_permissions() {
  test -d "$APP/.next" && test ! -L "$APP/.next"
  test -f "$APP/.next/BUILD_ID"
  getent group ai-executive >/dev/null
  chgrp -R ai-executive "$APP/.next"
  chmod -R g+rX,g-w "$APP/.next"
  runuser -u ai-executive -- test -r "$APP/.next/BUILD_ID"
  runuser -u ai-executive -- test -x "$APP/.next/server"
  runuser -u ai-executive -- test -r "$APP/node_modules/next/dist/bin/next"
}

http_code() { curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$1"; }

wait_ready() {
  local i
  for i in $(seq 1 60); do
    if curl -fsS --max-time 3 -o /dev/null \
      http://127.0.0.1:3000/manifest.webmanifest 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

verify_service() {
  systemctl is-active --quiet "$SERVICE" || return 1
  test "$(systemctl show "$SERVICE" -p User --value)" = ai-executive || return 1
  wait_ready || return 1
  test "$(http_code http://127.0.0.1:3000/api/auth/status)" = 200 || return 1
  test "$(http_code http://127.0.0.1:3000/api/store)" = 401 || return 1
  test "$(http_code "$HTTPS_BASE/manifest.webmanifest")" = 200 || return 1
  test "$(http_code "$HTTPS_BASE/api/auth/status")" = 200 || return 1
  test "$(http_code "$HTTPS_BASE/api/store")" = 401 || return 1
  sleep 3
  systemctl is-active --quiet "$SERVICE"
}

on_exit() {
  local rc="$1"
  trap - EXIT INT TERM HUP
  if [ "$rc" -eq 0 ]; then return 0; fi
  echo "NASAZENI SELHALO (kod $rc), zaloha: ${BACKUP:-nevytvorena}" >&2
  if [ "$STOPPED" != 1 ]; then exit "$rc"; fi
  set +e
  systemctl stop "$SERVICE"
  if [ "$CHANGED" = 1 ]; then
    echo "Vracim pouze kod na $PREV; produkcni data neobnovuji." >&2
    (
      cd "$APP" &&
      git reset --hard "$PREV" &&
      umask 022 &&
      pnpm install --frozen-lockfile &&
      pnpm build &&
      fix_build_permissions
    )
    if [ "$?" -ne 0 ]; then
      echo "KRITICKA CHYBA: rollback buildu selhal, sluzba zustava zastavena." >&2
      exit "$rc"
    fi
  fi
  if systemctl start "$SERVICE" && verify_service; then
    echo "Rollback: puvodni verze dostupna lokalne i pres HTTPS." >&2
  else
    echo "KRITICKA CHYBA: rollback neni zdravy, prover journalctl." >&2
    echo "Data nebyla automaticky obnovena; obnova vyzaduje rozhodnuti vlastnika." >&2
  fi
  exit "$rc"
}
trap 'on_exit "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

echo "=== PRE-FLIGHT ==="
test "$(id -u)" = 0 || die "spust jako root"
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || die "zadej uplny 40mistny SHA"
test "$(systemctl is-active "$SERVICE")" = active || die "sluzba nebezi"
test "$(systemctl show "$SERVICE" -p User --value)" = ai-executive || die "jiny ucet sluzby"
test "$(systemctl show "$SERVICE" -p WorkingDirectory --value)" = "$APP" || die "jiny adresar sluzby"
test -f "$DATA/store.sqlite" && test -f "$ENVFILE" || die "chybi data nebo env"
test ! -L "$DATA" && test ! -L "$ENVFILE" || die "necekany symlink"
test -z "$(find "$DATA" -type l -print -quit)" || die "symlink v datech"
test -d "$BACKUP_DIR" && test ! -L "$BACKUP_DIR" || die "chybi adresar zaloh"
test "$(stat -c %u "$BACKUP_DIR")" = 0 || die "zaloha neni pod rootem"

cd "$APP"
test "$(git branch --show-current)" = main || die "produkce neni na main"
test -z "$(git status --porcelain)" || die "lokalni zmeny v repozitari"
PREV="$(git rev-parse HEAD)"
git fetch --no-tags origin main
test "$(git rev-parse FETCH_HEAD)" = "$TARGET" || die "cil se neshoduje s origin/main"
test "$PREV" != "$TARGET" || die "verze uz bezi"
git merge-base --is-ancestor "$PREV" "$TARGET" || die "nelze fast-forward"
git diff --quiet "$PREV" "$TARGET" -- deployment/ai-executive.service || die "systemd jednotka se zmenila"
echo "Stavajici: $PREV"
echo "Cil:       $TARGET"

echo "=== KONZISTENTNI ZALOHA ==="
BACKUP="$(mktemp -d "$BACKUP_DIR/deploy-XXXXXXXX")"
chmod 0700 "$BACKUP"
STOPPED=1
systemctl stop "$SERVICE"
! systemctl is-active --quiet "$SERVICE" || die "sluzba se nezastavila"
(
  umask 077
  cp -a "$DATA" "$BACKUP/data"
  cp -a "$ENVFILE" "$BACKUP/env"
)
cmp "$DATA/store.sqlite" "$BACKUP/data/store.sqlite"
if [ -f "$DATA/store.sqlite-wal" ]; then
  cmp "$DATA/store.sqlite-wal" "$BACKUP/data/store.sqlite-wal"
else
  test ! -e "$BACKUP/data/store.sqlite-wal"
fi
runuser -u ai-executive -- /usr/bin/node \
  "$APP/scripts/check-data.mjs" "$DATA/store.sqlite" > "$BACKUP/before.json"
/usr/bin/node "$APP/scripts/check-data.mjs" \
  "$BACKUP/data/store.sqlite" > "$BACKUP/copy.json"

/usr/bin/node - "$BACKUP/before.json" "$BACKUP/copy.json" <<'NODE'
const fs = require("node:fs");
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, "utf8")));
if (a.integrity !== "ok" || b.integrity !== "ok" ||
    a.foreignKeyViolations !== 0 || b.foreignKeyViolations !== 0 ||
    JSON.stringify(a.tables) !== JSON.stringify(b.tables) ||
    a.mainFileSha256 !== b.mainFileSha256 ||
    a.walSha256 !== b.walSha256 || a.walBytes !== b.walBytes) {
  throw new Error("Zaloha SQLite/WAL neodpovida produkci");
}
console.log("Zaloha SQLite/WAL: OK");
NODE
(
  umask 077
  cd "$BACKUP"
  find data env -type f ! -name '*-shm' -print0 |
    sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum -c --quiet SHA256SUMS
)

echo "=== FAST-FORWARD A BUILD ==="
CHANGED=1
git merge --ff-only "$TARGET"
test "$(git rev-parse HEAD)" = "$TARGET"
umask 022
pnpm install --frozen-lockfile
pnpm build
fix_build_permissions
test -z "$(git status --porcelain)"

echo "=== START A PROVOZNI KONTROLY ==="
systemctl start "$SERVICE"
verify_service || die "sluzba nebo lokalni/HTTPS API nejsou dostupne"
runuser -u ai-executive -- /usr/bin/node \
  "$APP/scripts/check-data.mjs" "$DATA/store.sqlite" > "$BACKUP/after.json"

/usr/bin/node - "$BACKUP/before.json" "$BACKUP/after.json" <<'NODE'
const fs = require("node:fs");
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, "utf8")));
if (b.integrity !== "ok" || b.foreignKeyViolations !== 0)
  throw new Error("Integrita produkcni databaze selhala");
const volatile = new Set([
  "security_events", "security_alerts", "metadata",
  "attention_states", "attention_history", "pact_agent_runs", "schema_migrations"
]);
const ignored = new Set([
  "ai_proposals", "passkey_challenges", "calendar_events", "notification_deliveries"
]);
for (const [table, count] of Object.entries(a.tables)) {
  if (ignored.has(table)) continue;
  const after = b.tables[table];
  if (!(volatile.has(table) ? after >= count : after === count))
    throw new Error("Neocekavana zmena poctu zaznamu: " + table);
}
console.log("Integrita a pocty produkcnich zaznamu: OK");
NODE
systemctl is-active --quiet "$SERVICE"
STOPPED=0
echo "======================================"
echo "NASAZENI DOKONCENO"
echo "Commit: $(git rev-parse HEAD)"
echo "Zaloha: $BACKUP"
echo "Sluzba: $(systemctl is-active "$SERVICE")"
echo "Lokalni a Tailscale HTTPS: OK"
echo "======================================"
