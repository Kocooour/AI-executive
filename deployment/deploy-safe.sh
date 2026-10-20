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
BACKUP_VALIDATED=0

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

# Canonical row counts must not decrease. Use on deployment AND code rollback.
verify_row_counts() {
  local before="$1" after="$2"
  /usr/bin/node - "$before" "$after" <<'NODE'
const fs = require("node:fs");
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, "utf8")));
if (b.integrity !== "ok" || b.foreignKeyViolations !== 0)
  throw new Error("Integrita produkcni databaze selhala");
const ignored = new Set([
  "ai_proposals", "passkey_challenges", "calendar_events", "notification_deliveries"
]);
for (const [table, count] of Object.entries(a.tables)) {
  if (ignored.has(table)) continue;
  const after = b.tables[table];
  if (!Number.isSafeInteger(after) || after < count)
    throw new Error("KRITICKY UBYTEK zaznamu: " + table + " (" + count + " -> " + after + ")");
}
console.log("Integrita a pocty zaznamu: OK");
NODE
}

on_exit() {
  local rc="$1"
  trap - EXIT INT TERM HUP
  if [ "$rc" -eq 0 ]; then return 0; fi
  echo "NASAZENI SELHALO (kod $rc), zaloha: ${BACKUP:-nevytvorena}" >&2
  if [ "$STOPPED" != 1 ]; then exit "$rc"; fi
  set +e
  # Never strand the old service with its disk filled by a partial copy.
  # Only the exact unverified mktemp directory is ever removed.
  if [ "$BACKUP_VALIDATED" = 0 ] &&
     [[ "$BACKUP" == "$BACKUP_DIR"/deploy-???????? ]] &&
     [ -d "$BACKUP" ] && [ ! -L "$BACKUP" ]; then
    echo "Mazani neuplne (neoverene) kopie: $BACKUP" >&2
    rm -rf --one-file-system -- "$BACKUP" ||
      echo "KRITICKA CHYBA: neuplnou kopii nelze smazat, prover disk." >&2
  fi
  if ! systemctl stop "$SERVICE" || systemctl is-active --quiet "$SERVICE"; then
    echo "KRITICKA CHYBA: sluzba stale bezi; nelze bezpecne sestavovat rollback." >&2
    exit "$rc"
  fi
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
  if systemctl start "$SERVICE" && verify_service &&
     runuser -u ai-executive -- /usr/bin/node \
       "$APP/scripts/check-data.mjs" "$DATA/store.sqlite" > "$BACKUP/rollback.json" &&
     verify_row_counts "$BACKUP/before.json" "$BACKUP/rollback.json"; then
    echo "Rollback: puvodni verze dostupna a zaznamy zachovany." >&2
  else
    echo "KRITICKA CHYBA: rollback nezajistil zachovani dat ani zdravou sluzbu." >&2
    echo "Prover journalctl, aktualni data a predchozi zalohu; obnovu musi schvalit vlastnik." >&2
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

# Check reserve before taking the service down. Backup and build might be on
# different filesystems. If shared, the backup check includes the build reserve.
data_kb=$(du -sk "$DATA" | awk '{print $1}')
backup_free_kb=$(df -Pk "$BACKUP_DIR" | awk 'END {print $4}')
app_free_kb=$(df -Pk "$APP" | awk 'END {print $4}')
state_free_kb=$(df -Pk "$DATA" | awk 'END {print $4}')
build_reserve_kb=$((4 * 1024 * 1024))
state_reserve_kb=$((512 * 1024))
for value in "$data_kb" "$backup_free_kb" "$app_free_kb" "$state_free_kb"; do
  [[ "$value" =~ ^[0-9]+$ ]] || die "nelze zjistit diskovou kapacitu"
done
if (( backup_free_kb < data_kb + build_reserve_kb + state_reserve_kb )); then
  die "malo mista pro konzistentni zalohu + build + WAL"
fi
if (( app_free_kb < build_reserve_kb )); then
  die "malo mista pro build a pripadny rollback"
fi
if (( state_free_kb < state_reserve_kb )); then
  die "malo mista pro SQLite WAL"
fi
echo "Disk preflight: OK (zaloha $data_kb KiB, rezerva build 4 GiB a WAL 512 MiB)"

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
# Verify source vs copy including nested files and env. SQLite -shm is volatile.
cmp -s "$ENVFILE" "$BACKUP/env" || die "zaloha env neodpovida originalu"
diff -qr --exclude=store.sqlite-shm -- "$DATA" "$BACKUP/data" ||
  die "zaloha obsahuje neodpovidajici nebo chybejici soubory"
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
BACKUP_VALIDATED=1

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

verify_row_counts "$BACKUP/before.json" "$BACKUP/after.json"
systemctl is-active --quiet "$SERVICE"
STOPPED=0
echo "======================================"
echo "NASAZENI DOKONCENO"
echo "Commit: $(git rev-parse HEAD)"
echo "Zaloha: $BACKUP"
echo "Sluzba: $(systemctl is-active "$SERVICE")"
echo "Lokalni a Tailscale HTTPS: OK"
echo "======================================"
