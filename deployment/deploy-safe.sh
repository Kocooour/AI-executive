#!/usr/bin/env bash
# Lumi production deployment. Always execute THIS file from the verified target
# commit via deployment/DEPLOY.md, not the stale script on the checked-out main.
# The old running script cannot bootstrap features introduced only in the target.
set -Eeuo pipefail
umask 022
APP=/opt/ai-executive
DATA=/var/lib/ai-executive
ENVFILE=/etc/ai-executive/ai-executive.env
BACKUP_DIR=/var/backups/ai-executive
SERVICE=ai-executive
HTTPS_BASE=https://vm13861.tail412944.ts.net:8443
TARGET="${1:-}"
RECOVERY_MODE=0
PREV=""
BACKUP=""
STOPPED=0
CHANGED=0
# Fail closed if a revocation initialization could have begun, even if the
# feature commit was not completely installed.
OWNER_CUTOFF_INIT_ATTEMPTED=0
BACKUP_VALIDATED=0
# An integrity mismatch while the service was stopped is a known data incident.
# Rolling back code must not claim the affected Gmail consent/index survived.
MAIL_PRESTART_INTEGRITY_FAILED=0
MAIL_PRESTART_SNAPSHOT_FAILED=0
# Off path remains identical; these are used only for an explicitly configured
# personal-v1 target profile. No settings or private paths are printed.
TARGET_PROFILE=off
TARGET_DIRECTORY=""
TARGET_OWNER=""
TARGET_GENERATION=""
# Set only once the explicit C-3a v26 -> v27 Inbox upgrade has been invoked on
# the quiesced store after the verified archive. Earlier code cannot read v27.
TARGET_SCHEMA_UPGRADE_ATTEMPTED=0
# One-time outside-restore consent fence. A partial attempt never authorizes
# rollback to old consent-unaware code or recreation of prior grant history.
INBOX_AI_FENCE_PROVISION_ATTEMPTED=0
INBOX_AI_FENCE_FIRST_ROLLOUT=0
# Explicit operator recovery of an interrupted FIRST consent, never ordinary deploy.
FIRST_CONSENT_RECOVERY=0
INBOX_AI_FENCE_PATH=/var/lib/ai-executive-target/inbox-ai-consent-fence.sqlite
# Root-owned, non-restorable first-rollout proof. Its owner/generation and
# device+inode bind explicit recovery to the SAME fence provisioned by THIS
# first rollout, not any later empty replacement after a revoke.
INBOX_AI_FIRST_CONSENT_PROOF="$BACKUP_DIR/.inbox-ai-first-consent-pending"
PROFILE_TMP=""
PROFILE_TOOL=""
ENV_BASELINE_SHA=""

die() { echo "STOP: $*" >&2; exit 1; }

# Verify the active EnvironmentFile and disallow overriding fixed unit keys.
verify_loaded_environment_sources() {
  local files
  files="$(systemctl show "$SERVICE" -p EnvironmentFiles --value)" || return 1
  [ "$files" = "$ENVFILE (ignore_errors=no)" ] || return 1
  if LC_ALL=C grep -Eq '^[[:space:]]*(export[[:space:]]+)?(NODE_ENV|PORT|NEXT_TELEMETRY_DISABLED|AI_EXECUTIVE_DATA_DIR|NEXT_PUBLIC_[A-Za-z0-9_]+)[[:space:]]*=' "$ENVFILE"; then
    return 1
  else
    [ "$?" -eq 1 ]
  fi
}

# The approved isolated StateDirectory and exact security-alert outbox are the
# only writable exceptions. Never allow a generic ReadWritePaths override.
verify_loaded_write_sandbox() {
  local protect state state_mode rw
  protect="$(systemctl show "$SERVICE" -p ProtectSystem --value)" || return 1
  [ "$protect" = strict ] || return 1
  state="$(systemctl show "$SERVICE" -p StateDirectory --value)" || return 1
  # Resetting StateDirectory= also resets its mode to systemd's 0755 default.
  # Never allow that fallback to make either persistent data directory readable.
  state_mode="$(systemctl show "$SERVICE" -p StateDirectoryMode --value)" || return 1
  [ "$state_mode" = 0700 ] || return 1
  rw="$(systemctl show "$SERVICE" -p ReadWritePaths --value)" || return 1
  case "$rw" in
    ""|/var/lib/ai-executive-security/outbox) ;;
    *) return 1 ;;
  esac
  if [ "$TARGET_PROFILE" = personal-v1 ]; then
    [ "$TARGET_DIRECTORY" = /var/lib/ai-executive-target/personal-v1 ] || return 1
    [ "$state" = "ai-executive ai-executive-target" ] ||
      [ "$state" = "ai-executive-target ai-executive" ] || return 1
  else
    [ "$state" = ai-executive ] ||
      [ "$state" = "ai-executive ai-executive-target" ] ||
      [ "$state" = "ai-executive-target ai-executive" ] || return 1
  fi
}

# Fingerprint the exact reviewed root-owned env bytes. Even an off deployment
# must not restart after an operator/attacker changes that file during a build
# or rollback. No values or the digest are logged.
env_file_unchanged() {
  [ -n "$ENV_BASELINE_SHA" ] &&
    [ "$(sha256sum -- "$ENVFILE")" = "$ENV_BASELINE_SHA" ]
}

# Explicit opt-in after a failed first rollout has left the service stopped.
# Never interpret a stopped service as permission to recover automatically.
if [ "$#" -eq 3 ] && [ "$2" = "--recover-stopped" ] &&
   [ "$3" = "--recover-first-consent" ]; then
  RECOVERY_MODE=1
  FIRST_CONSENT_RECOVERY=1
elif [ "$#" -eq 2 ] && [ "$2" = "--recover-stopped" ]; then
  RECOVERY_MODE=1
else
  [ "$#" -eq 1 ] || die "pouziti: deploy-safe.sh <target-sha> [--recover-stopped [--recover-first-consent]]"
fi

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

# Capture IDs and lifecycle state, not user content. Run as the service account so
# opening SQLite cannot create a root-owned -shm/-wal on the live data directory.
# These snapshots are held only in the 0700 root-owned release backup.
snapshot_work_sessions() {
  runuser -u ai-executive -- /usr/bin/node - "$DATA/store.sqlite" <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  database.exec("BEGIN");
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const hasSessions = tables.has("work_sessions");
  const hasIntervals = tables.has("work_session_intervals");
  if (hasSessions !== hasIntervals) throw new Error("Neúplne schema pracovnich relaci");
  const snapshot = {
    hasSessions,
    sessions: hasSessions ? database.prepare(
      "SELECT id, workspace_id, state, completed_at FROM work_sessions ORDER BY id").all() : [],
    intervals: hasIntervals ? database.prepare(
      "SELECT id, session_id FROM work_session_intervals ORDER BY id").all() : [],
  };
  database.exec("COMMIT");
  console.log(JSON.stringify(snapshot));
} finally { database.close(); }
NODE
}

# Capture only mail-sync IDs, timestamps and retention settings for deployment
# integrity verification; no message subjects, senders or account secrets.
snapshot_mail_sync() {
  runuser -u ai-executive -- /usr/bin/node - "$DATA/store.sqlite" <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  database.exec("BEGIN");
  const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const hasSync = names.has("mail_sync_accounts") && names.has("mail_sync_messages");
  const snapshot = {
    accounts: hasSync ? database.prepare(
      "SELECT account_id, workspace_id, consent_id, retention_days FROM mail_sync_accounts ORDER BY account_id").all() : [],
    messages: hasSync ? database.prepare(
      "SELECT account_id, workspace_id, message_id, received_at FROM mail_sync_messages ORDER BY account_id, message_id").all() : [],
  };
  database.exec("COMMIT");
  console.log(JSON.stringify(snapshot));
} finally { database.close(); }
NODE
}

# While the service is STOPPED, no owner request can alter a Gmail sync
# consent or index. Detect data loss from build/pre-start maintenance strictly
# before the application begins serving traffic. After start these records can
# change legitimately (opt-out, Gmail deletion, retention and index cap).
verify_mail_sync_prestart() {
  local before="$1" prestart="$2"
  /usr/bin/node - "$before" "$prestart" <<'NODE'
const fs = require("node:fs");
const [before, after] = process.argv.slice(2).map(file => JSON.parse(fs.readFileSync(file, "utf8")));
if (JSON.stringify(before.accounts) !== JSON.stringify(after.accounts))
  throw new Error("KRITICKY UBYTEK/ZMENA: mail_sync_accounts pri zastavene sluzbe");
if (JSON.stringify(before.messages) !== JSON.stringify(after.messages))
  throw new Error("KRITICKY UBYTEK/ZMENA: mail_sync_messages pri zastavene sluzbe");
console.log("Gmail sync consent a metadata pred spustenim: bez zmen");
NODE
}

# Verify all non-retained owner tables monotonically, and validate session retention
# by exact IDs rather than row counts. Finishing a session legitimately removes
# the oldest completed session beyond 1000 and all of its intervals.
# This verifier runs on both deployment and code rollback.
verify_row_counts() {
  local before="$1" after="$2" before_sessions="$3" after_sessions="$4" before_mail="$5" after_mail="$6"
  /usr/bin/node - "$before" "$after" "$before_sessions" "$after_sessions" "$before_mail" "$after_mail" <<'NODE'
const fs = require("node:fs");
const [a, b, oldSessions, newSessions, oldMail, newMail] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, "utf8")));
if (b.integrity !== "ok" || b.foreignKeyViolations !== 0)
  throw new Error("Integrita produkcni databaze selhala");
const ignored = new Set([
  "ai_proposals", "passkey_challenges", "calendar_events", "notification_deliveries",
  // A bounded invalidation queue: 1001 records legitimately compact into 1 marker.
  "semantic_index_outbox"
]);
// Both mail tables can legitimately change after service startup. The
// strict off-line snapshot above checks their integrity before traffic resumes.
const retentionTables = new Set(["work_sessions", "work_session_intervals", "mail_sync_messages", "mail_sync_accounts"]);
for (const [table, count] of Object.entries(a.tables)) {
  if (ignored.has(table) || retentionTables.has(table)) continue;
  const after = b.tables[table];
  if (!Number.isSafeInteger(after) || after < count)
    throw new Error("KRITICKY UBYTEK zaznamu: " + table + " (" + count + " -> " + after + ")");
}
// The post-start snapshot is taken while the app serves owners again.
// Mail sync metadata is a rebuildable Gmail-derived index: a user may
// legitimately disable the index, Gmail may report deletions, or the
// 250-row cap may evict unexpired entries during this time window.
// Warn on unverifiable loss, but never roll back healthy code *after* the
// service is accepting requests. All canonical owner tables above and work
// session rows below retain their strict loss guards; full pre-start backup
// remains available for investigation.
const mailKey = r => r.account_id + ":" + r.message_id;
const beforeConsent = new Map(oldMail.accounts.map(r => [r.account_id, r]));
const afterConsent = new Map(newMail.accounts.map(r => [r.account_id, r]));
const changedConsent = oldMail.accounts.filter(old => {
  const current = afterConsent.get(old.account_id);
  return !current || current.workspace_id !== old.workspace_id ||
    current.consent_id !== old.consent_id ||
    current.retention_days !== old.retention_days;
});
if (changedConsent.length) console.warn("UPOZORNENI: " + changedConsent.length +
  " mail_sync_accounts se po spusteni sluzby zmenilo/smazalo; overte explicitni souhlas v auditu. Predstartovni kontrola byla bez zmen.");
const afterMessageIds = new Set(newMail.messages.map(mailKey));
const removedMail = oldMail.messages.filter(r => !afterMessageIds.has(mailKey(r)));
let expired = 0;
let other = 0;
const cutoffNow = Date.now();
for (const row of removedMail) {
  const old = beforeConsent.get(row.account_id);
  const current = afterConsent.get(row.account_id);
  if (old && current && old.workspace_id === row.workspace_id &&
      current.workspace_id === old.workspace_id && current.consent_id === old.consent_id &&
      Number.isSafeInteger(old.retention_days) && old.retention_days === current.retention_days &&
      Number.isSafeInteger(row.received_at) &&
      row.received_at < cutoffNow - old.retention_days * 86_400_000) expired++;
  else other++;
}
if (expired) console.log("Retence mail metadat overena: " + expired + " expirovanych zaznamu.");
if (other) console.warn("UPOZORNENI: " + other +
  " mail_sync_messages ubylo po spusteni sluzby (mohlo jit o sync, odpojeni nebo omezeni indexu); overte podle auditu. Kanonicka data jsou dale chranena.");
if (oldSessions.hasSessions && !newSessions.hasSessions)
  throw new Error("KRITICKY UBYTEK: zmizelo schema pracovnich relaci");
if (oldSessions.hasSessions) {
  if (a.tables.work_sessions !== oldSessions.sessions.length ||
      a.tables.work_session_intervals !== oldSessions.intervals.length)
    throw new Error("Nekonzistentni vychozi snapshot pracovnich relaci");
  const liveIds = new Set(newSessions.sessions.map(s => s.id));
  const removed = oldSessions.sessions.filter(s => !liveIds.has(s.id));
  const removedIds = new Set(removed.map(s => s.id));
  const liveIntervals = new Set(newSessions.intervals.map(s => s.id));
  // Only the completed *oldest* sessions can be pruned, per workspace, when
  // exactly 1000 newer completed sessions remain (work-sessions.ts retention).
  for (const session of removed) {
    if (session.state !== "completed" || !Number.isSafeInteger(session.completed_at))
      throw new Error("KRITICKY UBYTEK zaznamu: work_sessions (aktivni nebo bez data dokonceni)");
    const kept = newSessions.sessions.filter(s => s.workspace_id === session.workspace_id && s.state === "completed");
    if (kept.length !== 1000 || kept.some(s => !Number.isSafeInteger(s.completed_at)) ||
        session.completed_at > Math.min(...kept.map(s => s.completed_at)))
      throw new Error("KRITICKY UBYTEK zaznamu: work_sessions (nejde o legitimni retenci)");
  }
  // Intervals may be deleted only together with a proven-pruned parent
  // session; a missing interval for any kept session is an actual loss.
  for (const interval of oldSessions.intervals) {
    if (!liveIntervals.has(interval.id) && !removedIds.has(interval.session_id))
      throw new Error("KRITICKY UBYTEK zaznamu: work_session_intervals");
  }
  if (removed.length) console.log("Retence pracovnich relaci overena: " + removed.length + " nejstarsich dokonceni.");
}
console.log("Integrita a pocty zaznamu: OK");
NODE
}

on_exit() {
  local rc="$1"
  trap - EXIT INT TERM HUP
  # Exact private temporary checker created by this invocation only.
  if [ -n "$PROFILE_TMP" ] && [[ "$PROFILE_TMP" == "$LOCK_DIR"/profile-???????? ]] &&
     [ -d "$PROFILE_TMP" ] && [ ! -L "$PROFILE_TMP" ]; then
    rm -rf --one-file-system -- "$PROFILE_TMP" ||
      echo "UPOZORNENI: nelze odstranit docasny profilovy checker" >&2
  fi
  if [ "$rc" -eq 0 ]; then return 0; fi
  echo "NASAZENI SELHALO (kod $rc), zaloha: ${BACKUP:-nevytvorena}" >&2
  if [ "$MAIL_PRESTART_INTEGRITY_FAILED" = 1 ]; then
    echo "KRITICKA CHYBA: Gmail souhlas nebo metadata se zmenily pri zastavene sluzbe." >&2
    echo "Rollback vraci jen kod, NIKOLI databazi. Porovnej $BACKUP/before-mail.json a o obnove dat rozhoduje vlastnik." >&2
  elif [ "$MAIL_PRESTART_SNAPSHOT_FAILED" = 1 ]; then
    echo "UPOZORNENI: predstartovni Gmail snapshot neslo precist; nejde o potvrzenou ztratu dat." >&2
  fi
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
  # A failure before ANY code switch or cutoff-init attempt can safely restore
  # the still-checked-out old service: this deployment has not revoked cookies.
  # Recheck HEAD and the cutoff path, not merely a missing file or a boolean
  # computed at preflight. A possibly provisioned/lost cutoff fails closed.
  if [ "${OWNER_SESSION_FIRST_ROLLOUT:-0}" = 1 ] &&
     [ "$RECOVERY_MODE" != 1 ] &&
     [ "$CHANGED" = 0 ] &&
     [ "$OWNER_CUTOFF_INIT_ATTEMPTED" = 0 ] &&
     [ "$(git rev-parse HEAD)" = "$PREV" ] &&
     [ ! -e "$DATA/owner-session-valid-from.sqlite" ] &&
     [ ! -L "$DATA/owner-session-valid-from.sqlite" ]; then
    echo "Prvni rollout selhal pred zmenou kodu a pred pokusem o inicializaci: obnovuji puvodni sluzbu." >&2
  # After switching code (or attempting cutoff init), never reenable old
  # cookie validation by restarting pre-feature $PREV without secret rotation.
  elif [ "${OWNER_SESSION_FIRST_ROLLOUT:-0}" = 1 ] || [ "$RECOVERY_MODE" = 1 ]; then
    echo "BEZPECNOSTNI BLOKACE: neuspesne nasazeni nebo obnova revokace relaci." >&2
    echo "Sluzba zustava zastavena, bez automatickeho rollbacku a navratu k predchozi autentizaci." >&2
    echo "Oprav a nasad verzi s kontrolou revokace, nebo pred rucnim spustenim stare verze rotuj AI_EXECUTIVE_SESSION_SECRET." >&2
    exit "$rc"
  elif [ "$INBOX_AI_FENCE_PROVISION_ATTEMPTED" = 1 ]; then
    # The first C-3b fence may now exist, with a partial epoch-1 target
    # consent. Never reset the checkout to pre-C-3b code: explicit recovery
    # requires a consent-aware PREV and the exact original durable fence.
    echo "BEZPECNOSTNI BLOKACE: nedokonceny prvni Inbox AI consent rollout." >&2
    echo "Consent-aware kod zustava na disku; sluzba zustava zastavena. Bez automatickeho rollbacku." >&2
    exit "$rc"
  fi
  if [ "$CHANGED" = 1 ]; then
    echo "Vracim pouze kod na $PREV; produkcni data neobnovuji." >&2
    # Preserve the reviewed TARGET build helper across reset to a PREV commit
    # that does not yet contain C29. The wrapper builds even rollback code with
    # the validated profile; no operator NEXT_PUBLIC_* can bleed through.
    local rollback_helper
    rollback_helper="$(mktemp -d "$LOCK_DIR/build-XXXXXXXX")" || exit "$rc"
    mkdir -m 0700 "$rollback_helper/scripts" "$rollback_helper/lib" || exit "$rc"
    # Load from the reviewed target object, even if fast-forward failed before
    # its files reached the checkout.
    git show "$TARGET:scripts/target-build-profile.mjs" > "$rollback_helper/scripts/target-build-profile.mjs" &&
      git show "$TARGET:lib/target-personal-profile.ts" > "$rollback_helper/lib/target-personal-profile.ts" || exit "$rc"
    (
      cd "$APP" &&
      git reset --hard "$PREV" &&
      umask 022 &&
      pnpm install --frozen-lockfile &&
      /usr/bin/node "$rollback_helper/scripts/target-build-profile.mjs" --build "$TARGET_PROFILE" "$APP" &&
      fix_build_permissions
    )
    local rollback_result="$?"
    rm -rf --one-file-system -- "$rollback_helper"
    if [ "$rollback_result" -ne 0 ]; then
      echo "KRITICKA CHYBA: rollback buildu selhal, sluzba zustava zastavena." >&2
      exit "$rc"
    fi
  fi
  # An explicitly activated target cannot safely fall back to old code just
  # by restoring the git revision: systemd reloads the unchanged root-owned
  # EnvironmentFile on start. That would activate the very profile that just
  # failed semantic or archival verification. Preserve both data domains and
  # the code-only rollback above, but require an operator to disable/verify
  # the target flags before any recovery start.
  if [ "$TARGET_PROFILE" = personal-v1 ]; then
    echo "BEZPECNOSTNI BLOKACE: neuspesna aktivace personal-v1; restart s ponechanym .env je zakazan." >&2
    echo "Kod byl pripadne vracen; ani legacy, ani cilova data nebyla obnovena nebo smazana." >&2
    echo "Sluzba zustava zastavena. Operator musi explicitne vypnout cilove prepinace, overit profil off a schvalit samostatny postup obnovy." >&2
    if [ "$TARGET_SCHEMA_UPGRADE_ATTEMPTED" = 1 ] ||
     [ "$INBOX_AI_FENCE_PROVISION_ATTEMPTED" = 1 ]; then
      echo "Cilove uloziste mohlo byt migrovano na schema v27 (Inbox); predchozi kod v27 necte." >&2
      echo "Navrat na v26 je mozny jen schvalenou obnovou adresare target/ z overene zalohy: ${BACKUP:-nevytvorena}" >&2
    fi
    exit "$rc"
  fi
  # A failed off deployment can also see unit/env drift *after* its last
  # pre-start validation. Never restart old code with newly rejected flags.
  # These checks intentionally emit only a named failed policy, not values.
  # Keep separate tests so an unexpected rollback block can be diagnosed.
  if ! verify_loaded_environment_sources; then
    echo "BEZPECNOSTNI BLOKACE: zdroje prostredi systemd pri rollbacku." >&2
    exit "$rc"
  fi
  if ! env_file_unchanged; then
    echo "BEZPECNOSTNI BLOKACE: zmeneny obsah .env pri rollbacku." >&2
    exit "$rc"
  fi
  if ! verify_loaded_write_sandbox; then
    echo "BEZPECNOSTNI BLOKACE: systemd sandbox pri rollbacku." >&2
    exit "$rc"
  fi
  if systemctl start "$SERVICE" && verify_service; then
    if [ "$BACKUP_VALIDATED" = 1 ]; then
      if runuser -u ai-executive -- /usr/bin/node \
           "$APP/scripts/check-data.mjs" "$DATA/store.sqlite" > "$BACKUP/rollback.json" &&
         snapshot_work_sessions > "$BACKUP/rollback-sessions.json" &&
         snapshot_mail_sync > "$BACKUP/rollback-mail.json" &&
         verify_row_counts "$BACKUP/before.json" "$BACKUP/rollback.json" \
           "$BACKUP/before-sessions.json" "$BACKUP/rollback-sessions.json" \
           "$BACKUP/before-mail.json" "$BACKUP/rollback-mail.json"; then
        if [ "$MAIL_PRESTART_INTEGRITY_FAILED" = 1 ]; then
          echo "KRITICKA CHYBA: puvodni verze kodu dostupna, ale zachovani Gmail souhlasu/metadat NENI potvrzeno." >&2
          echo "Porovnej $BACKUP/before-mail.json a $BACKUP/rollback-mail.json. Obnova dat vyzaduje rozhodnuti vlastnika." >&2
        elif [ "$MAIL_PRESTART_SNAPSHOT_FAILED" = 1 ]; then
          echo "Rollback: puvodni verze kodu dostupna; predstartovni Gmail snapshot neslo precist. Data v tomto kroku nebyla overena." >&2
        else
          echo "Rollback: puvodni verze dostupna a zaznamy zachovany." >&2
        fi
      else
        echo "KRITICKA CHYBA: rollback neobnovil pocet zaznamu, data nemenit naslepo." >&2
        echo "Porovnej $BACKUP/before.json a $BACKUP/rollback.json; o obnove rozhoduje vlastnik." >&2
      fi
    elif runuser -u ai-executive -- /usr/bin/node \
         "$APP/scripts/check-data.mjs" "$DATA/store.sqlite" >/dev/null; then
      echo "Puvodni sluzba obnovena, neuplna zaloha odstranena." >&2
    else
      echo "KRITICKA CHYBA: SQLite po nezdarene zaloze neni konzistentni." >&2
    fi
  else
    echo "KRITICKA CHYBA: rollback nebo dostupnost sluzby selhala." >&2
    echo "Prover journalctl; produkcni data nebyla obnovena." >&2
  fi
  exit "$rc"
}
trap 'on_exit "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# The lock is root-owned and lives outside the checkout so an overlapping release
# cannot race another release's git, backup, build or rollback. FD 9 remains open
# throughout the EXIT trap; never remove the lock file (unlinking enables split locks).
echo "=== EXCLUSIVE DEPLOY LOCK ==="
test "$(id -u)" = 0 || die "spust jako root"
LOCK_DIR=/run/lock/ai-executive
test ! -L "$LOCK_DIR" || die "symlink v adresari zamku"
mkdir -p -m 0700 "$LOCK_DIR"
test -d "$LOCK_DIR" && test ! -L "$LOCK_DIR" || die "neplatny adresar zamku"
test "$(stat -c %u "$LOCK_DIR")" = 0 || die "adresar zamku nevlastni root"
chmod 0700 "$LOCK_DIR"
LOCK_FILE="$LOCK_DIR/deploy.lock"
test ! -L "$LOCK_FILE" || die "symlink v souboru zamku"
if test -e "$LOCK_FILE"; then
  test -f "$LOCK_FILE" && test "$(stat -c %u "$LOCK_FILE")" = 0 ||
    die "neplatny soubor zamku"
fi
umask 077
exec 9>>"$LOCK_FILE"
umask 022
chmod 0600 "$LOCK_FILE"
flock -n 9 || die "jine nasazeni uz probiha"
echo "Exkluzivni zamek nasazeni: OK"

echo "=== PRE-FLIGHT ==="
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || die "zadej uplny 40mistny SHA"
if [ "$RECOVERY_MODE" = 1 ]; then
  # Only an explicitly inactive unit is safe; failed/activating/unknown
  # systemd states are not proof that all old workers have stopped.
  test "$(systemctl is-active "$SERVICE")" = inactive ||
    die "rezim obnovy vyzaduje zastavenou sluzbu"
else
  test "$(systemctl is-active "$SERVICE")" = active || die "sluzba nebezi"
fi
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
if [ "$RECOVERY_MODE" != 1 ]; then
  test "$PREV" != "$TARGET" || die "verze uz bezi"
fi
git merge-base --is-ancestor "$PREV" "$TARGET" || die "nelze fast-forward"
if [ "$RECOVERY_MODE" = 1 ]; then
  # Recovery from a fail-closed, stopped deployment: only when the checked-out
  # version AND the reviewed target enforce the existing persistent cutoff.
  # This intentionally does not cover failures before first provisioning.
  git cat-file -e "$PREV:lib/owner-session-revocation.ts" 2>/dev/null ||
    die "obnova vyzaduje jiz nasazenou verzi s revokaci relaci"
  git cat-file -e "$TARGET:lib/owner-session-revocation.ts" 2>/dev/null ||
    die "cil obnovy neobsahuje revokaci relaci"
  test -f "$APP/scripts/owner-session-revocation-init.mjs" ||
    die "chybi kontrolni prikaz revokace relaci"
  runuser -u ai-executive -- env AI_EXECUTIVE_DATA_DIR="$DATA" /usr/bin/node \
    --experimental-loader "$APP/scripts/target-staging-ts-loader.mjs" \
    "$APP/scripts/owner-session-revocation-init.mjs" --check ||
    die "stav revokace relaci chybi nebo je neplatny; nikdy neobnovuj automaticky"
  echo "=== OBOVA ZASTAVENE SLUZBY: revokacni stav overen ==="
fi
# The only automatic initial provisioning allowed is a real first code rollout.
# Never recreate missing revocation history during a subsequent deploy/restart.
OWNER_SESSION_FIRST_ROLLOUT=0
if git cat-file -e "$TARGET:lib/target-inbox-ai-consent-fence.ts" 2>/dev/null &&
   ! git cat-file -e "$PREV:lib/target-inbox-ai-consent-fence.ts" 2>/dev/null; then
  INBOX_AI_FENCE_FIRST_ROLLOUT=1
fi
if git cat-file -e "$TARGET:lib/owner-session-revocation.ts" 2>/dev/null &&
   ! git cat-file -e "$PREV:lib/owner-session-revocation.ts" 2>/dev/null; then
  OWNER_SESSION_FIRST_ROLLOUT=1
fi
# Consent recovery is narrower than stopped-service recovery and may only
# touch a trusted PRE-EXISTING fence from a consent-aware checked-out release.
if [ "$FIRST_CONSENT_RECOVERY" = 1 ]; then
  git cat-file -e "$PREV:lib/target-inbox-ai-consent-fence.ts" 2>/dev/null ||
    die "obnova prvniho souhlasu vyzaduje jiz nasazeny consent-aware kod"
  git cat-file -e "$TARGET:lib/target-inbox-ai-consent-fence.ts" 2>/dev/null ||
    die "obnova prvniho souhlasu vyzaduje consent-aware cil"
  [ "$INBOX_AI_FENCE_FIRST_ROLLOUT" = 0 ] ||
    die "obnova prvniho souhlasu neni nova inicializace fence"
  test -f "$INBOX_AI_FENCE_PATH" && test ! -L "$INBOX_AI_FENCE_PATH" ||
    die "obnova prvniho souhlasu nesmi vytvorit chybejici fence"
fi
git diff --quiet "$PREV" "$TARGET" -- deployment/ai-executive.service || die "systemd jednotka se zmenila"
# Fail before stopping, even when the main env file appears to be off:
# a second loaded file or manager-global target flag can activate it.
verify_loaded_environment_sources ||
  die "neoverene zdroje prostredi systemd; kontrola konfigurace sluzby selhala"
ENV_BASELINE_SHA="$(sha256sum -- "$ENVFILE")" ||
  die "nelze overit hash konfigurace env"
# Do not evaluate the root-owned EnvironmentFile as shell. In the dormant
# legacy case we do no target probing, filesystem access or additional output.
# The exact validator is loaded from the REVIEWED target commit before stop,
# not from a possibly old checked-out version of the application.
# Keep a valid, disabled profile on the legacy fast path, without target I/O.
# Any duplicate disabled flag/operator setting or malformed target line still
# requires the canonical validator: invalid must fail before service stop.
# Capture a single non-secret marker; an awk I/O failure must not mean "off".
profile_needs_check="$(awk '
  /^[[:space:]]*(#|$)/ { next }
  {
    line=$0
    sub(/^[[:space:]]*/, "", line)
    if (line !~ /^AI_EXECUTIVE_TARGET_/) {
      # The CLI rejects malformed assignments mentioning target variables.
      if (line !~ /^[A-Za-z_][A-Za-z0-9_]*=/ &&
          index(line, "AI_EXECUTIVE_TARGET_") > 0) { print 1; exit }
      next
    }
    if (line !~ /^AI_EXECUTIVE_TARGET_[A-Za-z0-9_]+=/) {
      print 1; exit
    }
    key=line
    sub(/=.*/, "", key)
    if (key ~ /_ENABLED$/ ||
        key == "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY" ||
        key == "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID" ||
        key == "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION") {
      if (++seen[key] > 1) { print 1; exit }
    }
    if (key ~ /_ENABLED$/) {
      v=line
      sub(/^[^=]*=/, "", v)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      if (v!="false" && v!="\"false\"" && v!="\047false\047") {
        print 1; exit
      }
    }
  }
' "$ENVFILE")" || die "nelze zkontrolovat cilove prepinace v env"
if [ "$profile_needs_check" = 1 ]; then
  PROFILE_TMP="$(mktemp -d "$LOCK_DIR/profile-XXXXXXXX")"
  chmod 0700 "$PROFILE_TMP"
  mkdir -m 0700 "$PROFILE_TMP/scripts" "$PROFILE_TMP/lib"
  git show "$TARGET:scripts/target-profile-env.mjs" > "$PROFILE_TMP/scripts/target-profile-env.mjs" ||
    die "cil nema kontrolu profilu"
  git show "$TARGET:lib/target-personal-profile.ts" > "$PROFILE_TMP/lib/target-personal-profile.ts" ||
    die "cil nema definici profilu"
  chmod 0600 "$PROFILE_TMP/scripts/target-profile-env.mjs" "$PROFILE_TMP/lib/target-personal-profile.ts"
  PROFILE_TOOL="$PROFILE_TMP/scripts/target-profile-env.mjs"
  TARGET_PROFILE="$(/usr/bin/node "$PROFILE_TOOL" --check "$ENVFILE")" ||
    die "neplatny nebo castecny profil v env"
  if [ "$TARGET_PROFILE" = personal-v1 ]; then
    TARGET_DIRECTORY="$(/usr/bin/node "$PROFILE_TOOL" --setting "$ENVFILE" AI_EXECUTIVE_TARGET_STAGING_DIRECTORY)" ||
      die "nelze nacist adresar ciloveho uloziste"
    TARGET_OWNER="$(/usr/bin/node "$PROFILE_TOOL" --setting "$ENVFILE" AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID)" ||
      die "nelze nacist vlastnika ciloveho uloziste"
    TARGET_GENERATION="$(/usr/bin/node "$PROFILE_TOOL" --setting "$ENVFILE" AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION)" ||
      die "nelze nacist generaci ciloveho uloziste"
    # Live database is NOT opened here: SQLite may currently hold -wal/-shm.
    test -d "$TARGET_DIRECTORY" && test ! -L "$TARGET_DIRECTORY" ||
      die "cilovy adresar neexistuje nebo je symlink"
    case "$TARGET_DIRECTORY/" in "$DATA/"*) die "cilove uloziste prekryva legacy data";; esac
    test "$(stat -c %u "$TARGET_DIRECTORY")" = "$(id -u ai-executive)" &&
      test "$(stat -c %a "$TARGET_DIRECTORY")" = 700 ||
      die "cilovy adresar nema vlastnika ai-executive a rezim 0700"
  fi
fi
if [ "$FIRST_CONSENT_RECOVERY" = 1 ] && [ "$TARGET_PROFILE" != personal-v1 ]; then
  die "obnova prvniho souhlasu vyzaduje schvaleny profil personal-v1"
fi
# Reject weakened sandboxing also for legacy-only/off deployments.
verify_loaded_write_sandbox ||
  die "systemd sandbox nedovoluje zapis do ciloveho uloziste, ProtectSystem=strict nebo StateDirectoryMode=0700"
env_file_unchanged || die "env se zmenilo behem predstartovniho overovani"
echo "Stavajici: $PREV"
echo "Cil:       $TARGET"

# Check reserve before taking the service down. Backup and build might be on
# different filesystems. If shared, the backup check includes the build reserve.
data_kb=$(du -sk "$DATA" | awk '{print $1}')
if [ "$TARGET_PROFILE" = personal-v1 ]; then
  target_kb=$(du -sk "$TARGET_DIRECTORY" | awk '{print $1}')
  [[ "$target_kb" =~ ^[0-9]+$ ]] || die "nelze zjistit velikost ciloveho uloziste"
  data_kb=$((data_kb + target_kb))
fi
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
# Semantic check requires a quiet store. Run with the service effective UID;
# never as root (the provision checker enforces UID identity).
verify_target_store() {
  local actual expected
  actual="$(runuser -u ai-executive -- env AI_EXECUTIVE_DATA_DIR="$DATA" /usr/bin/node \
    "$APP/scripts/target-store-provision.mjs" --check "$TARGET_DIRECTORY")" || return 1
  expected="$(printf '%s\n' \
    "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=$TARGET_DIRECTORY" \
    "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID=$TARGET_OWNER" \
    "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=$TARGET_GENERATION")"
  [ "$actual" = "$expected" ]
}
# Explicit C-3a Inbox schema upgrade/check of the quiesced store, as the
# service user. Exactly the approved directory and restore generation.
run_target_inbox_upgrade() {
  runuser -u ai-executive -- env AI_EXECUTIVE_DATA_DIR="$DATA" /usr/bin/node \
    --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
    --experimental-loader "$APP/scripts/target-staging-ts-loader.mjs" \
    "$APP/scripts/target-staging-upgrade-inbox.mjs" "$1" \
    --directory "$TARGET_DIRECTORY" --generation "$TARGET_GENERATION"
}
# External consent state is NOT inside target/personal-v1. A verified
# pre-existing fence is archived for incident investigation only: NEVER
# auto-restore that potentially stale snapshot over a newer revoke.
if [ "$TARGET_PROFILE" = personal-v1 ] && [ -e "$INBOX_AI_FENCE_PATH" ]; then
  test -f "$INBOX_AI_FENCE_PATH" && test ! -L "$INBOX_AI_FENCE_PATH" &&
    test "$(stat -c %u "$INBOX_AI_FENCE_PATH")" = "$(id -u ai-executive)" &&
    test "$(stat -c %a "$INBOX_AI_FENCE_PATH")" = 600 ||
    die "externi consent fence neni duveryhodny"
fi
if [ "$TARGET_PROFILE" = personal-v1 ]; then
  verify_target_store || die "cilovy preflight: neshoda vlastnika, generace nebo integrity"
fi
(
  umask 077
  cp -a "$DATA" "$BACKUP/data"
  cp -a "$ENVFILE" "$BACKUP/env"
  if [ "$TARGET_PROFILE" = personal-v1 ]; then
    cp -a "$TARGET_DIRECTORY" "$BACKUP/target"
    if [ -f "$INBOX_AI_FENCE_PATH" ]; then
      cp -a "$INBOX_AI_FENCE_PATH" "$BACKUP/inbox-ai-consent-fence.sqlite"
    fi
  fi
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
if [ "$TARGET_PROFILE" = personal-v1 ]; then
  diff -qr -- "$TARGET_DIRECTORY" "$BACKUP/target" ||
    die "cilova zaloha obsahuje neodpovidajici nebo chybejici soubory"
  if [ -f "$INBOX_AI_FENCE_PATH" ]; then
    cmp "$INBOX_AI_FENCE_PATH" "$BACKUP/inbox-ai-consent-fence.sqlite" ||
      die "zaloha souhlasu se neshoduje se zdrojem"
  fi
  # The backup is only safe to use if the *same* owner and restore
  # generation still match the operator-approved env. A self-consistent
  # but substituted target would pass --check without this comparison.
  verify_target_store ||
    die "cilovy preflight se po zaloze zmenil (vlastnik, generace nebo integrita)"
fi
runuser -u ai-executive -- /usr/bin/node \
  "$APP/scripts/check-data.mjs" "$DATA/store.sqlite" > "$BACKUP/before.json"
snapshot_work_sessions > "$BACKUP/before-sessions.json"
snapshot_mail_sync > "$BACKUP/before-mail.json"
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
  if [ "$TARGET_PROFILE" = personal-v1 ]; then
    find data env target -type f ! -name '*-shm' -print0 | sort -z |
      xargs -0 sha256sum > SHA256SUMS
    if [ -f inbox-ai-consent-fence.sqlite ]; then
      sha256sum inbox-ai-consent-fence.sqlite >> SHA256SUMS
    fi
  else
    find data env -type f ! -name '*-shm' -print0 |
      sort -z | xargs -0 sha256sum > SHA256SUMS
  fi
  # All target sidecars, SQLite, witness and append-only journal are hashed in
  # the SAME verified archive as the legacy store. Never restore data in trap.
  # (The off branch intentionally retains the existing hash manifest.)
  sha256sum -c --quiet SHA256SUMS
)
BACKUP_VALIDATED=1

echo "=== FAST-FORWARD A BUILD ==="
CHANGED=1
if [ "$PREV" != "$TARGET" ]; then
  git merge --ff-only "$TARGET"
fi
test "$(git rev-parse HEAD)" = "$TARGET"
umask 022
pnpm install --frozen-lockfile
# The verified profile controls the *compiled* shell. A restart cannot switch it.
/usr/bin/node "$APP/scripts/target-build-profile.mjs" --build "$TARGET_PROFILE" "$APP"
fix_build_permissions
test -z "$(git status --porcelain)"

# Verify owner-cookie cutoff before the new app can start. First-time init is
# authorized ONLY when this code is newly introduced in the deployed commit.
# Existing state is never overwritten; missing state on later deploys fails closed.
if git cat-file -e "$TARGET:lib/owner-session-revocation.ts" 2>/dev/null; then
  OWNER_CUTOFF="$DATA/owner-session-valid-from.sqlite"
  test -f "$APP/scripts/owner-session-revocation-init.mjs" ||
    die "chybi prikaz pro inicializaci vlastnicke relace"
  if [ ! -e "$OWNER_CUTOFF" ] && [ ! -L "$OWNER_CUTOFF" ]; then
    [ "$OWNER_SESSION_FIRST_ROLLOUT" = 1 ] ||
      die "zmizel revokacni stav; obnov puvodni stav nebo pred novou inicializaci vymen session secret"
    echo "=== JEDNORAZOVA INICIALIZACE REVOKACE RELACE ==="
    OWNER_CUTOFF_INIT_ATTEMPTED=1
    runuser -u ai-executive -- env AI_EXECUTIVE_DATA_DIR="$DATA" /usr/bin/node \
      --experimental-loader "$APP/scripts/target-staging-ts-loader.mjs" \
      "$APP/scripts/owner-session-revocation-init.mjs" --init ||
      die "inicializace revokacniho stavu selhala"
  fi
  runuser -u ai-executive -- env AI_EXECUTIVE_DATA_DIR="$DATA" /usr/bin/node \
    --experimental-loader "$APP/scripts/target-staging-ts-loader.mjs" \
    "$APP/scripts/owner-session-revocation-init.mjs" --check ||
    die "neplatny revokacni stav vlastnickych relaci"
fi

# Deployment/code-build work cannot silently alter consent or indexed mail
# while the service remains stopped. Snapshot before any user traffic resumes.
if ! snapshot_mail_sync > "$BACKUP/prestart-mail.json"; then
  MAIL_PRESTART_SNAPSHOT_FAILED=1
  die "nelze nacist Gmail sync snapshot pred startem nove verze"
fi
if ! verify_mail_sync_prestart "$BACKUP/before-mail.json" "$BACKUP/prestart-mail.json"; then
  MAIL_PRESTART_INTEGRITY_FAILED=1
  die "Gmail souhlas nebo metadata se zmenily pri zastavene sluzbe"
fi

if [ "$TARGET_PROFILE" = personal-v1 ]; then
  # C-3a: the reviewed personal-v1 profile includes Inbox, which needs the v27
  # target schema. The explicit, idempotent v26 -> v27 upgrade runs ONLY here:
  # after the verified combined archive, with the service stopped, as the
  # service user, and before any new-code start. Never on app startup.
  # An already-current v27 store is a no-op; any other state fails closed and
  # the service stays stopped (see on_exit). Output is status JSON only.
  echo "=== CILOVE SCHEMA INBOX (v26 -> v27) ==="
  ! systemctl is-active --quiet "$SERVICE" || die "sluzba bezi pred migraci ciloveho schematu"
  test -f "$APP/scripts/target-staging-upgrade-inbox.mjs" ||
    die "cil nema prikaz pro migraci ciloveho schematu Inbox"
  verify_target_store ||
    die "cilovy preflight pred migraci schematu: neshoda vlastnika, generace nebo integrity"
  TARGET_SCHEMA_UPGRADE_ATTEMPTED=1
  run_target_inbox_upgrade --apply ||
    die "migrace ciloveho schematu Inbox selhala"
  run_target_inbox_upgrade --check ||
    die "cilove uloziste po migraci neni aktualni schema Inbox"
fi

# New C-3b fence AND the owner-approved first consent grant are written
# only during the FIRST reviewed missing-fence rollout, after the verified
# archive and quiesced v27 upgrade. Later deploys only CHECK both stores:
# never regenerate a revoked decision after restore, crash, or rollback.
if [ "$TARGET_PROFILE" = personal-v1 ] &&
   git cat-file -e "$TARGET:lib/target-inbox-ai-consent-fence.ts" 2>/dev/null; then
  test -f "$APP/scripts/target-inbox-ai-fence-provision.mjs" ||
    die "chybi overeny prikaz consent fence"
  ! systemctl is-active --quiet "$SERVICE" ||
    die "consent fence se nesmi inicializovat za behu"
  if [ ! -e "$INBOX_AI_FENCE_PATH" ] && [ ! -L "$INBOX_AI_FENCE_PATH" ]; then
    [ "$INBOX_AI_FENCE_FIRST_ROLLOUT" = 1 ] ||
      die "chybi drive provisionovana revokacni historie; automaticky neobnovovat"
    [ ! -e "$INBOX_AI_FIRST_CONSENT_PROOF" ] &&
      [ ! -L "$INBOX_AI_FIRST_CONSENT_PROOF" ] ||
      die "neocekavany zaznam nedokonceneho prvniho souhlasu"
    INBOX_AI_FENCE_PROVISION_ATTEMPTED=1
    echo "=== JEDNORAZOVA INICIALIZACE CONSENT FENCE A SOUHLASU ==="
    runuser -u ai-executive -- env AI_EXECUTIVE_DATA_DIR="$DATA" /usr/bin/node \
      --experimental-loader "$APP/scripts/target-staging-ts-loader.mjs" \
      "$APP/scripts/target-inbox-ai-fence-provision.mjs" --provision \
      --directory "$TARGET_DIRECTORY" ||
      die "inicializace externi consent fence selhala"
    # Persist the provenance BEFORE first grant; preserve on failure. Never
    # create this proof for a previously existing, possibly revoked fence.
    ( umask 077; set -C; printf '%s\n' \
      "v1:$TARGET_OWNER:$TARGET_GENERATION:$(stat -c '%d:%i' "$INBOX_AI_FENCE_PATH")" \
      > "$INBOX_AI_FIRST_CONSENT_PROOF" ) ||
      die "nelze bezpecne zapsat doklad prvni inicializace fence"
    # Owner decision #471/#492 authorizes ONE first-deploy grant, not
    # subsequent re-consent. This command is never called on later deploys.
    runuser -u ai-executive -- env AI_EXECUTIVE_DATA_DIR="$DATA" \
      LUMI_INBOX_AI_FIRST_ROLLOUT=1 /usr/bin/node \
      --experimental-loader "$APP/scripts/target-staging-ts-loader.mjs" \
      "$APP/scripts/target-inbox-ai-fence-provision.mjs" --first-grant \
      --directory "$TARGET_DIRECTORY" --owner "$TARGET_OWNER" \
      --generation "$TARGET_GENERATION" ||
      die "prvni souhlas Inbox AI nebyl bezpecne zapsan do obou ulozist"
  elif [ "$FIRST_CONSENT_RECOVERY" = 1 ]; then
    # A pristine SQLite file alone is NOT proof of a never-revoked consent:
    # an old fence could have been replaced. This root-owned marker pins the
    # exact owner/generation AND physical file created by the failed rollout.
    test -f "$INBOX_AI_FIRST_CONSENT_PROOF" &&
      test ! -L "$INBOX_AI_FIRST_CONSENT_PROOF" &&
      test "$(stat -c %u "$INBOX_AI_FIRST_CONSENT_PROOF")" = 0 &&
      test "$(stat -c %a "$INBOX_AI_FIRST_CONSENT_PROOF")" = 600 &&
      test "$(cat "$INBOX_AI_FIRST_CONSENT_PROOF")" = \
        "v1:$TARGET_OWNER:$TARGET_GENERATION:$(stat -c '%d:%i' "$INBOX_AI_FENCE_PATH")" ||
      die "chybi platny puvodni doklad nedokonceneho prvniho nasazeni"
    # Explicit stopped-service owner recovery. Never create a missing fence.
    # The privileged writer refuses any prior external decision, grant,
    # pending ticket, or target state other than the initial epoch 1.
    echo "=== VYSLOVNE SCHVALENA OBNOVA NEDOKONCENEHO PRVNIHO SOUHLASU ==="
    runuser -u ai-executive -- env AI_EXECUTIVE_DATA_DIR="$DATA" \
      LUMI_INBOX_AI_FIRST_ROLLOUT=1 /usr/bin/node \
      --experimental-loader "$APP/scripts/target-staging-ts-loader.mjs" \
      "$APP/scripts/target-inbox-ai-fence-provision.mjs" --first-grant \
      --directory "$TARGET_DIRECTORY" --owner "$TARGET_OWNER" \
      --generation "$TARGET_GENERATION" ||
      die "obnova prvniho souhlasu odmitnuta: historie uz existuje nebo stav neni bezpecny"
  fi
  runuser -u ai-executive -- env AI_EXECUTIVE_DATA_DIR="$DATA" /usr/bin/node \
    --experimental-loader "$APP/scripts/target-staging-ts-loader.mjs" \
    "$APP/scripts/target-inbox-ai-fence-provision.mjs" --check \
    --directory "$TARGET_DIRECTORY" --owner "$TARGET_OWNER" \
    --generation "$TARGET_GENERATION" ||
    die "nesouhlasici nebo chybejici C-3b souhlas a revokacni fence"
  if [ "$INBOX_AI_FENCE_FIRST_ROLLOUT" = 1 ] ||
     [ "$FIRST_CONSENT_RECOVERY" = 1 ]; then
    # Consent has been durably checked in BOTH stores. Remove the root proof
    # before the service can ever start; never retain a replay capability.
    test -f "$INBOX_AI_FIRST_CONSENT_PROOF" &&
      test ! -L "$INBOX_AI_FIRST_CONSENT_PROOF" &&
      rm -- "$INBOX_AI_FIRST_CONSENT_PROOF" ||
      die "nelze zneplatnit doklad prvniho souhlasu"
  fi
fi

echo "=== START A PROVOZNI KONTROLY ==="
# Catch build/profile/checkout drift before the first service start.
/usr/bin/node "$APP/scripts/target-build-profile.mjs" --check "$TARGET_PROFILE" "$APP" ||
  die "profil sestavene aplikace neodpovida schvalenemu profilu"
if [ "$TARGET_PROFILE" = personal-v1 ]; then
  # Catch a changed root-only env before allowing the first target request.
  [ "$(/usr/bin/node "$PROFILE_TOOL" --check "$ENVFILE")" = personal-v1 ] ||
    die "cilovy profil se pred startem zmenil"
  [ "$(/usr/bin/node "$PROFILE_TOOL" --setting "$ENVFILE" AI_EXECUTIVE_TARGET_STAGING_DIRECTORY)" = "$TARGET_DIRECTORY" ] &&
  [ "$(/usr/bin/node "$PROFILE_TOOL" --setting "$ENVFILE" AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID)" = "$TARGET_OWNER" ] &&
  [ "$(/usr/bin/node "$PROFILE_TOOL" --setting "$ENVFILE" AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION)" = "$TARGET_GENERATION" ] ||
    die "cilove nastaveni se pred startem zmenilo"
  # Install/build and auth/mail prestart operations run after the backup.
  # Recheck the actual quiet store NOW, before it may serve any request.
  verify_target_store ||
    die "cilovy preflight tesne pred startem: neshoda vlastnika, generace nebo integrity"
fi
# systemd drop-ins can be changed independently of the checked-out repo.
# Confirm the loaded environment sources again before allowing a start.
verify_loaded_environment_sources ||
  die "zdroje prostredi systemd se pred startem zmenily"
verify_loaded_write_sandbox ||
  die "systemd sandbox se pred startem zmenil"
env_file_unchanged ||
  die "env se pred startem zmenilo"
systemctl start "$SERVICE"
verify_service || die "sluzba nebo lokalni/HTTPS API nejsou dostupne"
if [ "$TARGET_PROFILE" = personal-v1 ]; then
  # Post-start semantic recheck must be offline. The live target SQLite may
  # have transient sidecars; the provision checker deliberately rejects them.
  # Re-quiesce the service, verify the real live store, then resume and check
  # HTTP readiness again. Both failures retain the existing code-only rollback.
  systemctl stop "$SERVICE"
  ! systemctl is-active --quiet "$SERVICE" || die "sluzba se pri kontrole ciloveho uloziste nezastavila"
  verify_target_store || die "cilovy preflight po prvnim startu selhal"
  verify_loaded_environment_sources ||
    die "zdroje prostredi systemd se pred druhym startem zmenily"
  verify_loaded_write_sandbox ||
    die "systemd sandbox se pred druhym startem zmenil"
      env_file_unchanged ||
    die "env se pred druhym startem zmenilo"
  systemctl start "$SERVICE"
  verify_service || die "sluzba po kontrole ciloveho uloziste neni dostupna"
fi
runuser -u ai-executive -- /usr/bin/node \
  "$APP/scripts/check-data.mjs" "$DATA/store.sqlite" > "$BACKUP/after.json"
snapshot_work_sessions > "$BACKUP/after-sessions.json"
snapshot_mail_sync > "$BACKUP/after-mail.json"

verify_row_counts "$BACKUP/before.json" "$BACKUP/after.json" \
  "$BACKUP/before-sessions.json" "$BACKUP/after-sessions.json" \
  "$BACKUP/before-mail.json" "$BACKUP/after-mail.json"
systemctl is-active --quiet "$SERVICE"
STOPPED=0
echo "======================================"
echo "NASAZENI DOKONCENO"
echo "Commit: $(git rev-parse HEAD)"
echo "Zaloha: $BACKUP"
echo "Sluzba: $(systemctl is-active "$SERVICE")"
echo "Lokalni a Tailscale HTTPS: OK"
echo "======================================"
