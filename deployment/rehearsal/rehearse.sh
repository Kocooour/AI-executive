#!/usr/bin/env bash
# Rehearsal of the move to a dedicated service account (docs/PRECHOD-SYSTEMOVY-UCET.md, steps 2-5 and 8).
#
# It needs no systemd and no container. Run it as root inside a DISPOSABLE machine or container: it
# creates two system users (lumi-old, ai-executive) and removes them again. Everything else lives under
# one prefix directory. Real paths (/opt, /var/lib, /etc, /home) are never touched.
#
#   sudo deployment/rehearsal/rehearse.sh            # prefix is a fresh temp directory
#   REHEARSAL_PREFIX=/srv/lumi-rehearsal-new sudo -E deployment/rehearsal/rehearse.sh   # must not exist yet
#
# The checkout must be built (pnpm build). Ports: 3160 old instance, 3162 new instance (override with
# OLD_PORT / NEW_PORT). Only the file-system and account separation is exercised. systemd-only
# properties (ProtectSystem, ProtectHome namespaces, EnvironmentFile parsing, StateDirectory, UMask,
# CapabilityBoundingSet) are NOT, and must be confirmed on the server (procedure step 8).
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root inside a disposable environment." >&2; exit 2; }
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
[ -d "$REPO/.next" ] && [ -d "$REPO/node_modules" ] || { echo "Build the checkout first: pnpm install --frozen-lockfile && pnpm build" >&2; exit 2; }
NODE=$(readlink -f "$(command -v node)")
OLD_PORT=${OLD_PORT:-3160}
NEW_PORT=${NEW_PORT:-3162}
OLD_USER=lumi-old
NEW_USER=ai-executive
PASSWORD="rehearsal-only-password"

for name in "$OLD_USER" "$NEW_USER"; do
  if id "$name" >/dev/null 2>&1; then echo "User $name already exists; refusing to run on a machine that may be real." >&2; exit 2; fi
done
for port in "$OLD_PORT" "$NEW_PORT"; do
  if (: </dev/tcp/127.0.0.1/"$port") 2>/dev/null; then echo "Port $port is in use." >&2; exit 2; fi
done

# The prefix is removed at the end, so it must be a directory this run creates: a given
# REHEARSAL_PREFIX must not exist yet (its parent must).
if [ -n "${REHEARSAL_PREFIX:-}" ]; then
  case "$REHEARSAL_PREFIX" in /*) ;; *) echo "REHEARSAL_PREFIX must be an absolute path." >&2; exit 2;; esac
  [ ! -e "$REHEARSAL_PREFIX" ] || { echo "REHEARSAL_PREFIX $REHEARSAL_PREFIX already exists; give a new path (it is deleted at the end)." >&2; exit 2; }
  mkdir -- "$REHEARSAL_PREFIX" || exit 2
  PREFIX=$REHEARSAL_PREFIX
else
  PREFIX=$(mktemp -d /tmp/lumi-rehearsal.XXXXXX)
fi
chmod 0755 "$PREFIX"
OLD_HOME=$PREFIX/home/$OLD_USER
OLD_DIR=$OLD_HOME/app
OPT=$PREFIX/opt/ai-executive
STATE=$PREFIX/var/lib/ai-executive
ENVFILE=$PREFIX/etc/ai-executive/ai-executive.env
BACKUP=$PREFIX/var/backups/pre-account
LOGS=$PREFIX/logs
mkdir -p "$PREFIX/home" "$PREFIX/opt" "$PREFIX/var/lib" "$PREFIX/etc/ai-executive" "$BACKUP" "$LOGS"
chmod 0755 "$PREFIX/home" "$PREFIX/opt" "$PREFIX/var" "$PREFIX/var/lib" "$PREFIX/etc"
chmod 0700 "$PREFIX/var/backups" "$BACKUP" "$LOGS"

PIDS=()
CREATED_USERS=()
PASS=0
FAIL=0
cleanup() {
  local status=$? pid
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -- "-$pid" 2>/dev/null; done
  sleep 1
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -9 -- "-$pid" 2>/dev/null; done
  local name
  for name in "${CREATED_USERS[@]:-}"; do [ -n "$name" ] && userdel "$name" 2>/dev/null; done
  getent group "$NEW_USER" >/dev/null && groupdel "$NEW_USER" 2>/dev/null
  getent group "$OLD_USER" >/dev/null && groupdel "$OLD_USER" 2>/dev/null
  if [ -z "${KEEP:-}" ]; then rm -rf -- "$PREFIX"; else echo "Prefix kept: $PREFIX"; fi
  echo
  echo "SUMMARY: $PASS passed, $FAIL failed"
  if [ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ] && [ "$status" -eq 0 ]; then echo "RESULT: PASS"; exit 0; fi
  echo "RESULT: FAIL"
  # The exit status says the same as the summary (also for an early exit or an interruption).
  [ "$status" -ne 0 ] && exit "$status"; exit 1
}
trap cleanup EXIT
trap 'exit 130' INT TERM

ok() { PASS=$((PASS + 1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $1"; }
# check "description" command...  (passes when the command exits 0)
check() { local description=$1; shift; if "$@" >/dev/null 2>&1; then ok "$description"; else bad "$description"; fi; }
# check_not "description" command...  (passes when the command fails)
check_not() { local description=$1; shift; if "$@" >/dev/null 2>&1; then bad "$description"; else ok "$description"; fi; }
equal() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', expected '$3')"; fi; }
step() { echo; echo "== $1"; }

# --- accounts ---------------------------------------------------------------------------------
step "Accounts"
useradd --system --user-group --home-dir "$OLD_HOME" --no-create-home --shell /usr/sbin/nologin "$OLD_USER" && CREATED_USERS+=("$OLD_USER")
useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$NEW_USER" && CREATED_USERS+=("$NEW_USER")
equal "the new account is not in the old account's group" "$(id -nG "$NEW_USER" | tr ' ' '\n' | grep -cx "$OLD_USER")" 0

# --- old installation: checkout in a 0750 home with .data and .env -----------------------------
step "Old installation (stand-in for hermesadmin)"
mkdir -p "$OLD_HOME"
cp -a "$REPO" "$OLD_DIR"
# Like a real checkout: the tracked .env.example stays, any other .env* and .data do not.
rm -rf "$OLD_DIR/.git" "$OLD_DIR/.data" "$OLD_DIR/test-results"
find "$OLD_DIR" -maxdepth 1 -name '.env*' ! -name .env.example -delete
chown -R "$OLD_USER:$OLD_USER" "$OLD_HOME" && chmod 0750 "$OLD_HOME"
HASH=$(printf '%s\n' "$PASSWORD" | (cd "$REPO" && "$NODE" scripts/hash-password.mjs 2>/dev/null) | tail -n 1)
SECRET=$(head -c 48 /dev/urandom | base64 -w0)
# Like the real .env: it also sets the variables the new unit owns (they must be stripped on migration).
{
  echo "AI_EXECUTIVE_AUTH_ENABLED=true"
  echo "AI_EXECUTIVE_PASSWORD_HASH=$HASH"
  echo "AI_EXECUTIVE_SESSION_SECRET=$SECRET"
  echo "NODE_ENV=production"
  echo "PORT=$OLD_PORT"
  echo "AI_EXECUTIVE_DATA_DIR=$OLD_DIR/.data"
} > "$OLD_DIR/.env"
chown "$OLD_USER:$OLD_USER" "$OLD_DIR/.env" && chmod 0600 "$OLD_DIR/.env"

# start_instance <user> <cwd> <port> <logfile> [KEY=value ...]  -> sets STARTED_PID
start_instance() {
  local user=$1 cwd=$2 port=$3 log=$4
  shift 4
  local uid gid
  uid=$(id -u "$user"); gid=$(id -g "$user")
  : > "$log"
  chmod 0644 "$log"
  (
    cd "$cwd" || exit 1
    umask 077
    exec setsid setpriv --reuid "$uid" --regid "$gid" --clear-groups \
      env -i PATH="$(dirname "$NODE"):/usr/bin:/bin" HOME=/nonexistent NEXT_TELEMETRY_DISABLED=1 "$@" \
      "$NODE" "$cwd/node_modules/next/dist/bin/next" start --port "$port" --hostname 127.0.0.1 >> "$log" 2>&1
  ) &
  STARTED_PID=$!
  PIDS+=("$STARTED_PID")
  local i
  for i in $(seq 1 90); do
    curl -fsS -o /dev/null "http://127.0.0.1:$port/manifest.webmanifest" 2>/dev/null && return 0
    kill -0 "$STARTED_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}
stop_instance() {
  kill -- "-$1" 2>/dev/null
  local i
  for i in $(seq 1 20); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.5; done
  kill -9 -- "-$1" 2>/dev/null
}

# api <port> <cookie> <method> <path> [json body] -> prints body, sets HTTP_STATUS
api() {
  local port=$1 cookie=$2 method=$3 path=$4 body=${5:-} out
  local args=(-sS -X "$method" -H "Origin: http://localhost:$port" -w '\n%{http_code}')
  [ -n "$cookie" ] && args+=(-H "Cookie: ai_executive_session=$cookie")
  [ -n "$body" ] && args+=(-H "content-type: application/json" --data "$body")
  out=$(curl "${args[@]}" "http://127.0.0.1:$port$path")
  HTTP_STATUS=${out##*$'\n'}
  printf '%s' "${out%$'\n'*}"
}
status_of() { api "$@" >/dev/null; echo "$HTTP_STATUS"; }
login() { # login <port> -> prints the session cookie value
  local port=$1
  curl -sS -i -X POST -H "Origin: http://localhost:$port" -H "content-type: application/json" \
    --data "{\"password\":\"$PASSWORD\"}" "http://127.0.0.1:$port/api/auth/login" \
    | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: ai_executive_session=\([^;]*\).*/\1/p' | head -n 1
}
entity_count() { api "$1" "$2" GET /api/store | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).entities.length))'; }
facts() { runuser -u "$1" -- "$NODE" "$2/scripts/check-data.mjs" "$3"; }
tables_of() { "$NODE" -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).tables))'; }
integrity_of() { "$NODE" -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).integrity)'; }

# --- old instance: seed ------------------------------------------------------------------------
step "Old instance runs and is seeded through the API"
if start_instance "$OLD_USER" "$OLD_DIR" "$OLD_PORT" "$LOGS/old.log"; then ok "old instance started as $OLD_USER on $OLD_PORT"; else bad "old instance started"; tail -n 20 "$LOGS/old.log"; exit 1; fi
OLD_PID=$STARTED_PID
equal "old: /api/store is 401 without a session" "$(status_of "$OLD_PORT" "" GET /api/store)" 401
equal "old: wrong password is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Origin: http://localhost:$OLD_PORT" -H 'content-type: application/json' --data '{"password":"wrong-password-xx"}' "http://127.0.0.1:$OLD_PORT/api/auth/login")" 401
COOKIE=$(login "$OLD_PORT")
[ -n "$COOKIE" ] && ok "old: sign-in with the password works" || { bad "old: sign-in"; exit 1; }
SNAPSHOT=$(api "$OLD_PORT" "$COOKIE" GET /api/store)
NOW=$(date +%s)000
BODY=$(printf '%s' "$SNAPSHOT" | NOW=$NOW "$NODE" -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const snap = JSON.parse(s); const now = Number(process.env.NOW);
    const entity = (id, type, title, properties = {}) => ({ id, type, title, status: type === "project" ? "active" : "open", workspaceId: "personal", properties, createdAt: now, updatedAt: now });
    const entities = [...snap.entities, entity("reh-project", "project", "Rehearsal project"), entity("reh-task-1", "task", "Rehearsal task one", { inbox: true }), entity("reh-task-2", "task", "Rehearsal task two", { inbox: true })];
    console.log(JSON.stringify({ baseRevision: snap.revision, entities, relations: snap.relations, deletedIds: [], revivedIds: [] }));
  });')
api "$OLD_PORT" "$COOKIE" PUT /api/store "$BODY" >/dev/null
equal "old: seeding PUT /api/store is 200" "$HTTP_STATUS" 200
OLD_ENTITIES=$(entity_count "$OLD_PORT" "$COOKIE")
[ "${OLD_ENTITIES:-0}" -ge 3 ] && ok "old: $OLD_ENTITIES entities stored" || bad "old: entities stored (${OLD_ENTITIES:-none})"
api "$OLD_PORT" "$COOKIE" POST /api/backups '{"action":"create"}' >/dev/null
equal "old: backup created through the API" "$HTTP_STATUS" 200
stop_instance "$OLD_PID"

# --- procedure step 1-2: inventory, backup, verify the copy ------------------------------------
step "Procedure step 2: backup and verified copy"
OLD_FACTS=$(facts "$OLD_USER" "$REPO" "$OLD_DIR/.data/store.sqlite")
OLD_TABLES=$(printf '%s' "$OLD_FACTS" | tables_of)
equal "old data: integrity ok" "$(printf '%s' "$OLD_FACTS" | integrity_of)" ok
echo "      tables: $OLD_TABLES"
cp -a "$OLD_DIR/.data" "$BACKUP/data"
cp -a "$OLD_DIR/.env" "$BACKUP/env"
(cd "$BACKUP" && find . -type f -print0 | sort -z | xargs -0 sha256sum > "$BACKUP/MANIFEST.sha256")
check "backup manifest verifies" bash -c "cd '$BACKUP' && grep -v MANIFEST MANIFEST.sha256 | sha256sum -c --quiet"
BACKUP_FACTS=$("$NODE" "$REPO/scripts/check-data.mjs" "$BACKUP/data/store.sqlite")
equal "backup copy: counts equal the original" "$(printf '%s' "$BACKUP_FACTS" | tables_of)" "$OLD_TABLES"
equal "backup copy: integrity ok" "$(printf '%s' "$BACKUP_FACTS" | integrity_of)" ok
OLD_SHA=$(sha256sum "$OLD_DIR/.data/store.sqlite" | cut -d' ' -f1)

# --- procedure step 4: code (root-owned) -------------------------------------------------------
step "Procedure step 4: code directory"
cp -a "$REPO" "$OPT"
rm -rf "$OPT/.git" "$OPT/.data" "$OPT/test-results"
find "$OPT" -maxdepth 1 -name '.env*' ! -name .env.example -delete
chown -R root:root "$OPT" && chmod -R go-w "$OPT" && chmod 0755 "$OPT"
# The runbook's own check (step 4): only the tracked .env.example is allowed.
code_dir_clean() { [ -z "$(ls -A "$1" | grep -E '^\.(env|data)' | grep -vxF '.env.example' || true)" ]; }
check ".env.example is present and the runbook check for stray .env*/.data passes" bash -c "$(declare -f code_dir_clean); test -f '$OPT/.env.example' && code_dir_clean '$OPT'"
mkdir -p "$OPT/.data" && check_not "the same check fails when a .data directory is present" bash -c "$(declare -f code_dir_clean); code_dir_clean '$OPT'"; rmdir "$OPT/.data"
touch "$OPT/.env.local" && check_not "the same check fails when .env.local is present" bash -c "$(declare -f code_dir_clean); code_dir_clean '$OPT'"; rm -f "$OPT/.env.local"
# Procedure step 4: root clones a checkout owned by another account. Plain `git clone` is refused
# ("dubious ownership"); the runbook uses a temporary global config with safe.directory = *.
GITSRC=$OLD_HOME/gitsrc
runuser -u "$OLD_USER" -- bash -c "mkdir '$GITSRC' && cd '$GITSRC' && git init -q -b main && echo x > f && git add f && git -c user.name=t -c user.email=t@t commit -q -m init"
check_not "plain git clone as root of a foreign-owned repo is refused" git clone -q --no-hardlinks "$GITSRC" "$PREFIX/clone-plain"
SAFE=$(mktemp); printf '[safe]\n\tdirectory = *\n' > "$SAFE"
check "git clone as root of a foreign-owned repo works with the temporary global config" env GIT_CONFIG_GLOBAL="$SAFE" git clone -q --no-hardlinks "$GITSRC" "$PREFIX/clone-ok"
rm -f "$SAFE"; rm -rf "$PREFIX/clone-plain" "$PREFIX/clone-ok" "$GITSRC"
check_not "the service user cannot write to the code directory" runuser -u "$NEW_USER" -- touch "$OPT/probe"
check_not "the service user cannot write to .next" runuser -u "$NEW_USER" -- touch "$OPT/.next/probe"

# --- procedure step 5: data and secrets --------------------------------------------------------
step "Procedure step 5: data and secrets"
cp -a "$OLD_DIR/.data" "$STATE"
chown -R "$NEW_USER:$NEW_USER" "$STATE"
chmod 0700 "$STATE"
find "$STATE" -type d -exec chmod 0700 {} +
find "$STATE" -type f -exec chmod 0600 {} +
cp "$OLD_DIR/.env" "$ENVFILE"
chown root:root "$ENVFILE" && chmod 0600 "$ENVFILE"
sed -i -E '/^(export[[:space:]]+)?(AI_EXECUTIVE_DATA_DIR|PORT|NODE_ENV)=/d' "$ENVFILE"
equal "env file: owner-controlled keys removed" "$(grep -cE '^(AI_EXECUTIVE_DATA_DIR|PORT|NODE_ENV)=' "$ENVFILE")" 0
equal "env file: other keys kept (names)" "$(sed 's/=.*//' "$ENVFILE" | sort | tr '\n' ' ')" "AI_EXECUTIVE_AUTH_ENABLED AI_EXECUTIVE_PASSWORD_HASH AI_EXECUTIVE_SESSION_SECRET "
check_not "the service user cannot read the env file" runuser -u "$NEW_USER" -- cat "$ENVFILE"
NEW_FACTS=$(facts "$NEW_USER" "$OPT" "$STATE/store.sqlite")
equal "new location: counts equal the original" "$(printf '%s' "$NEW_FACTS" | tables_of)" "$OLD_TABLES"
equal "new location: integrity ok (run as $NEW_USER)" "$(printf '%s' "$NEW_FACTS" | integrity_of)" ok
equal "state directory mode is 700 and owned by the service user" "$(stat -c '%a %U' "$STATE")" "700 $NEW_USER"

# --- code directory listing before the new instance runs ---------------------------------------
listing() { find "$OPT" -printf '%y %p %s %T@ %u %m\n' | sort; }
listing > "$LOGS/code-before.txt"
HOME_LISTING_BEFORE=$(find "$OLD_HOME" -printf '%y %p %s %T@\n' | sort | sha256sum)

# --- procedure step 7-8: new instance ----------------------------------------------------------
step "Procedure steps 7-8: new instance as $NEW_USER"
mapfile -t ENV_ARGS < <(grep -vE '^\s*(#|$)' "$ENVFILE")
if start_instance "$NEW_USER" "$OPT" "$NEW_PORT" "$LOGS/new.log" NODE_ENV=production PORT="$NEW_PORT" AI_EXECUTIVE_DATA_DIR="$STATE" "${ENV_ARGS[@]}"; then ok "new instance started as $NEW_USER on $NEW_PORT"; else bad "new instance started"; tail -n 20 "$LOGS/new.log"; exit 1; fi
NEW_PID=$STARTED_PID
equal "process user is $NEW_USER" "$(ps -o user= -p "$NEW_PID" | tr -d ' ')" "$NEW_USER"
equal "new: sign-in page is 200" "$(status_of "$NEW_PORT" "" GET /)" 200
equal "new: /api/auth/status is 200" "$(status_of "$NEW_PORT" "" GET /api/auth/status)" 200
equal "new: /api/store is 401 without a session" "$(status_of "$NEW_PORT" "" GET /api/store)" 401
COOKIE=$(login "$NEW_PORT")
[ -n "$COOKIE" ] && ok "new: sign-in with the same password works" || bad "new: sign-in with the same password"
equal "new: /api/store is 200 with a session" "$(status_of "$NEW_PORT" "$COOKIE" GET /api/store)" 200
equal "new: entity count equals the old instance" "$(entity_count "$NEW_PORT" "$COOKIE")" "$OLD_ENTITIES"
api "$NEW_PORT" "$COOKIE" POST /api/backups '{"action":"create"}' >/dev/null
equal "new: backup created through the API" "$HTTP_STATUS" 200
NEW_BACKUPS=$(find "$STATE/backups" -type f -newer "$ENVFILE" 2>/dev/null | wc -l)
[ "$NEW_BACKUPS" -ge 1 ] && ok "new: a backup file exists in the new state directory" || bad "new: backup file in the new state directory"
equal "new: backup files are 0600 and owned by $NEW_USER" "$(find "$STATE/backups" -type f -printf '%m %u\n' | sort -u)" "600 $NEW_USER"
HEXPORT=$(printf '%04X' "$NEW_PORT")
check "new: the process listens on 127.0.0.1" grep -qE "0100007F:$HEXPORT [0-9A-F:]+ 0A " /proc/net/tcp
check_not "new: nothing listens on any other address" grep -qE "(00000000|[0-9A-F]{8}):$HEXPORT [0-9A-F:]+ 0A " <(grep -v "0100007F:$HEXPORT" /proc/net/tcp /proc/net/tcp6 2>/dev/null | sed 's/^[^:]*://')
check_not "new: the service user cannot list the old home" runuser -u "$NEW_USER" -- ls "$OLD_HOME"
check_not "new: the service user cannot read the old .env" runuser -u "$NEW_USER" -- cat "$OLD_DIR/.env"
check_not "new: the service user cannot read the old database" runuser -u "$NEW_USER" -- cat "$OLD_DIR/.data/store.sqlite"
# A few more requests, then compare the code directory.
for path in / /manifest.webmanifest /api/auth/status; do status_of "$NEW_PORT" "" GET "$path" >/dev/null; done
listing > "$LOGS/code-after.txt"
if diff -q "$LOGS/code-before.txt" "$LOGS/code-after.txt" >/dev/null; then ok "nothing under the code directory changed while serving requests and creating a backup"; else bad "the code directory changed"; diff "$LOGS/code-before.txt" "$LOGS/code-after.txt" | head -n 20; fi
equal "the old home is unchanged by the new instance" "$(find "$OLD_HOME" -printf '%y %p %s %T@\n' | sort | sha256sum)" "$HOME_LISTING_BEFORE"
equal "the old database is unchanged by the new instance" "$(sha256sum "$OLD_DIR/.data/store.sqlite" | cut -d' ' -f1)" "$OLD_SHA"
equal "no permission or read-only errors in the new log" "$(grep -cE 'EACCES|EROFS|EPERM|SQLITE_CANTOPEN|readonly' "$LOGS/new.log")" 0
stop_instance "$NEW_PID"
LAST_FACTS=$(facts "$NEW_USER" "$OPT" "$STATE/store.sqlite")
equal "new data after the run: integrity ok" "$(printf '%s' "$LAST_FACTS" | integrity_of)" ok

# --- procedure step 9: rollback ----------------------------------------------------------------
step "Procedure step 9: rollback to the untouched old data"
if start_instance "$OLD_USER" "$OLD_DIR" "$OLD_PORT" "$LOGS/old2.log"; then ok "old instance started again from the untouched .data/.env"; else bad "rollback: old instance started"; tail -n 20 "$LOGS/old2.log"; fi
OLD2_PID=$STARTED_PID
equal "rollback: /api/store is 401 without a session" "$(status_of "$OLD_PORT" "" GET /api/store)" 401
COOKIE=$(login "$OLD_PORT")
[ -n "$COOKIE" ] && ok "rollback: sign-in with the same password works" || bad "rollback: sign-in"
equal "rollback: entity count equals the original" "$(entity_count "$OLD_PORT" "$COOKIE")" "$OLD_ENTITIES"
stop_instance "$OLD2_PID"
