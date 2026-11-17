# R4 — cutover runbook (PREPARATION ONLY)

**Status:** decision-support draft for issue #408 (stream C7), not approval or a production procedure to execute yet.
**Milestone:** B — R4 cutover preparation.
**Acceptance:** a content-free inventory and a passing archival-backup/restore-equality rehearsal on a *disposable, offline copy*, with negative tests. No agent operation on production.

## Immutable safety boundary

Neither this runbook nor any tool in #408 authorizes a production cutover, database/cache reset, migration, deletion, credential rotation, target flag activation, or replacement of persisted state. The separate #422 tool may provision ONLY a brand-new isolated target directory on an operator-approved path, with explicit confirmation and preflight; this is not runtime activation or approval to operate on production data. An agent **must not** run #408 tools against production. Only read-only observations of a pre-existing, independently captured **offline** copy and writes into **new, explicitly named, empty** output directories are in scope. Do not open the live SQLite file even for a "read-only" check: a SQLite connection may create or update WAL/SHM files. Keep copies of WAL with the main SQLite file; a bare copy of an active WAL-mode main file is not evidence of a consistent backup.

The old and target stores are distinct data domains. A backup of the legacy database (including the app's format-v2 owner-data export) is **not** a complete archival backup of credentials, passkeys, push subscriptions, integration secrets or target-store journal/witness state. Preserve the complete offline directory snapshot as the archive; treat app exports as additional, narrower recovery artifacts.


## C14 — activation preflight and isolated target backup (#424; no production activation)

This milestone adds \`scripts/target-profile-env.mjs\` and a guarded
\`deployment/deploy-safe.sh\` path. Running the generator only **prints**
a profile template; it never writes \`.env\`. The three existing operator
settings must be supplied from the canonical provision output and verified
identity. \`--check <env-file>\` reports \`off\`, complete \`personal-v1\`, or
\`invalid\`, with only missing/extra variable names on error. No target
flags are enabled by committed files, and this PR does not authorize an
environment change.

**C29 / owner decision 2026-11-16 — build profile is part of the cutover.**
A validated `personal-v1` build MUST compile the v1 shell with
`NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`, including the Quick Capture "+" on
mobile and desktop. A validated `off` build MUST unset the flag even when
the operator supplied it in the shell. The source of truth is
`TARGET_PERSONAL_V1_BUILD_ENV` in `lib/target-personal-profile.ts`.
`deploy-safe.sh` uses the profile-bound builder for the forward and
rollback build and verifies `.next/lumi-build-profile.json` (profile,
build ID and checkout SHA) before start. The root-owned EnvironmentFile
must not assign any `NEXT_PUBLIC_*` variable. Safari's disposable
`personal-v1` instance compiles with the same constant. Before opening
Safari, an authenticated, CA-verified HTTPS smoke reads the owner HTML only
to locate its unique Next `app/page-*.js` client bundle, fetches that bundle
through the same proxy and refuses a missing compiled v1 shell marker.
SSR HTML alone is insufficient because the app shell renders after hydration.
This is a release gate, **not** production activation.

Before any service stop, the deployment validates the selected `off` or
`personal-v1` profile in the root-owned EnvironmentFile, rejects malformed or
partial activation, and rejects assignments that override fixed unit settings
(`AI_EXECUTIVE_DATA_DIR`, `PORT`, `NODE_ENV`, `NEXT_TELEMETRY_DISABLED`).
The loaded unit must use only that mandatory EnvironmentFile. Its exact bytes
are fingerprinted and rechecked before starts and any off rollback.

For target activation, the approved canonical path is
`/var/lib/ai-executive-target/personal-v1`; the loaded unit must have
`ProtectSystem=strict`, `StateDirectory=ai-executive ai-executive-target`
(in either order), `StateDirectoryMode=0700` and `ReadWritePaths` either **empty** or exactly
`/var/lib/ai-executive-security/outbox` (the approved security-alert outbox).
No other writable exception is approved. Off-mode deployment accepts the original
`StateDirectory=ai-executive` as well as the separately installed drop-in.

This is an operational-error model, not a defense against an administrator
who controls root-owned systemd drop-ins. Full execution/hardening/mount
pinning and manager environment inspection are not part of this PR.
The script does not install or change the systemd unit itself.

**Approved owner decision: option (a)**, a separate
systemd \`StateDirectory=ai-executive-target\` for an isolated absolute target
path under \`/var/lib/ai-executive-target/personal-v1\`. The current unit's
\`ProtectSystem=strict\` makes that path unwritable despite POSIX 0700
ownership. A second \`StateDirectory\` supplies both persistent ownership
and an explicit systemd write exception, without weakening the legacy data
boundary. **Reject (b)** (target as a subdirectory of
\`/var/lib/ai-executive\`): that overlaps \`AI_EXECUTIVE_DATA_DIR\` under
\`scripts/r4-path-boundary.mjs\` and must be rejected by provisioning. Do
not change that path guard to make nested target stores appear valid.

The owner approved this exact path and second-StateDirectory design.
Installing or enabling the drop-in is a **separate operator action**, never
performed by this PR or the deploy script. The reviewed drop-in content is:

\`\`\`ini
# /etc/systemd/system/ai-executive.service.d/target-store.conf
[Service]
StateDirectory=
StateDirectory=ai-executive ai-executive-target
StateDirectoryMode=0700
\`\`\`

The `StateDirectoryMode=0700` line is mandatory: clearing `StateDirectory=`
resets its mode to systemd's default `0755`. Without the explicit mode,
the next restart can weaken permissions on **both** the legacy and target
state directories, even if the tracked service unit specifies `0700`.

The operator must independently install the approved override and run
`systemctl daemon-reload`. **Before any service restart**, check the loaded
mode explicitly:

```sh
test "$(systemctl show ai-executive -p StateDirectoryMode --value)" = 0700
systemctl show ai-executive -p StateDirectory -p ProtectSystem -p StateDirectoryMode
```

Stop if this assertion fails; correct the drop-in and repeat `daemon-reload`
without restarting the service. Only then perform an ordinary service restart
and a service-user write test to the exact target directory **without
touching real data files**. The versioned \`deployment/ai-executive.service\`
remains unchanged, so the existing code-diff safety guard is not bypassed.
A missing loaded write exception causes \`deploy-safe.sh\` to fail **before
stop**.

For \`personal-v1\` deployments: profile check, target directory existence,
UID/permissions, and systemd writable-sandbox check happen before stop;
canonical semantic \`target-store-provision.mjs --check\` runs with
\`runuser -u ai-executive --\` only when service writers are stopped.
The full directory (SQLite, witness, journal and companions) is saved as
\`target/\` within the **same verified** \`deploy-XXXXXXXX\` backup as
legacy \`data/\` and \`env\`. The common hash manifest covers all files and
the source-versus-copy directory diff must match. Immediately after the
copy, before any new-code start, the quiesced target store is checked again
**against the configured owner and restore generation**, not just for internal
consistency: this also rejects a substituted but valid store. On failure,
only an unverified partial copy is deleted. Because install/build and
other prestart work can run after the archive verification, repeat the
*same identity-bound semantic preflight* again on the still-quiesced
target **immediately before the first service start**, so a later
change cannot be served. Post-start checking quiesces the service
again to avoid transient SQLite sidecars before a further semantic preflight,
then restarts and checks HTTP readiness. Only code is automatically rolled
back, **never either data domain**. This introduces a second short service
restart exclusively for an activated target.

**Failure of activated personal-v1 (fail closed):** if any target-enabled
deployment step fails after service stop (including generation mismatch,
incomplete archive, build failure, post-start semantic preflight, or later
verification), leave the service **stopped** even if previous code was
successfully rebuilt. The root-owned EnvironmentFile still has enabled target
flags. Restarting old code would reload those flags and could serve the very
store that failed preflight. Preserve any verified archive, all live store
files and operator configuration; do not auto-edit the env file, restore a
data directory, or start the old code.

**Return to legacy:** under separately reviewed operational authorization,
set all flags of the `personal-v1` profile (`lib/target-personal-profile.ts`)
to false/absent and validate the `off` profile before a separately reviewed
recovery. **Do not restart the old process or reuse an existing `.next`.**
An authorized return to legacy means validating `off` in the effective env
and performing a **fresh `off` build through the reviewed
`deployment/deploy-safe.sh` recovery/deploy procedure**. A restart alone
cannot change Next's compiled flags. Confirm the
actual loaded EnvironmentFile has the verified `off` profile, not merely
the previous git revision. Do not remove, import, reset, overwrite or
restore target and legacy stores as a side effect. Preserve the target
archive and restore-generation evidence for subsequent incident review.

Before production: run the focused CLI/deploy regression suite and PR
Checks, verify systemd sandbox with the actual service context, perform
the controlled offline combined-store restore rehearsal, pass **full Browser
E2E on the exact approved SHA**, and obtain the separate owner approval
specified in this runbook.


## Ordered evidence and gates

| Step | Human/operator action | Evidence required before proceeding |
| --- | --- | --- |
| 0 | Record intended deployment SHA and current production source/store locations **without printing secrets**; confirm the latest `main` and related PR heads. | Signed-off scope and exact SHA; no state mutation |
| 1 | Enumerate active browser tabs, installed PWAs and browsers on phones/desktops; coordinate with everyone who has a local copy. | Device/client inventory (manual checklist below), with acknowledgement per client |
| 2 | Confirm owner-session revocation from #402 is merged, explicitly provisioned and functional. | Init proof, successful owner logout/re-login, copied-cookie denial, clean CI |
| 3 | Resolve #388 BFCache lifecycle failures (see C15 BFCache appendix below) and demonstrate stale/returning clients cannot write old state. | Focused BFCache/restore-generation barrier evidence, exact test SHA |
| 3a | After owner approval of the intended **new** target path and single-owner ID, run `scripts/target-store-provision.mjs` **as the effective OS service user `ai-executive`, not root**, then check it as the same UID **before the coordinated archival snapshot**. Create no legacy data; leave all target flags off. | Three private settings, service UID on target and all companions, same-UID read-only `--check`; no activation |
| 4 | **After step 3a**, capture a **consistent, coordinated** archival snapshot while writers are quiesced or through an approved atomic filesystem/SQLite backup procedure. Preserve legacy DB + WAL, backups, credentials, integration state and the **new target SQLite + append-only journal + witness** as one recovery unit. Include a detached target-directory copy in step 6 with `--target-offline`. An earlier legacy-only backup is **not** a substitute for this combined capture. | Immutable combined archive identifier, restrictive permissions, file manifest/checksums, protected retention location |
| 5 | Run `scripts/cutover-inventory.mjs` on the offline copy, giving a new output location. Review only aggregated counts, timestamp ranges and boolean presence. | Content-free JSON, short summary, secret-content rejection tests |
| 6 | Run the copy-only rehearsal in `deployment/rehearsal/` using a new empty output location. Check copied files, table rows, SHA-256 digests and SQLite `integrity_check` plus tamper/missing-table/non-empty-destination negative tests. **One-source copy fidelity is not independent backup verification.** | Private backup manifest and scoped copy-fidelity report; optional comparison of two separate input paths; independent capture still requires external evidence |
| 7 | Confirm the proposed target production store location and settings in [R4 target decision draft](R4-TARGET-STORE-DECISION-DRAFT.md); verify its own journal/witness/restore-generation plan and archival recovery, without implementing the switchover. | Owner-reviewed configuration proposal; no target flags enabled |
| 8 | Run typecheck, relevant unit/integration tests, production build and `PR Checks`; resolve all review findings. | Green PR checks and clean full-diff review on current head |
| 9 | After the intended release commits are on `main`, run the **full Browser E2E** only as the pre-deployment gate on the exact proposed deploy SHA. | Successful dispatch with matching `target_sha`, verified checked-out SHA and browser results |
| 10 | **STOP for explicit separate owner approval.** Do not schedule, script or infer consent from earlier decisions. | Written approval of precisely the proposed production changes and rollback boundary |

**Exact owner approval scope to request, not to presume:**

> Schvaluji samostatné produkční nasazení cílového modelu Lumi pouze pro jednoho vlastníka a soukromé Oblasti, na přesně určeném commitu `<40-znakový SHA>`, s cílovým úložištěm `<ověřená absolutní cesta>`, se zachováním nedotčeného archivního originálu `<identifikátor zálohy>`, ověřenou obnovou a rollback plánem `<odkaz>`. Výslovně schvaluji pouze konkrétně vyjmenované přepínače a datové kroky v předloženém plánu. Neschvaluji smazání jiných databází, lokálních kopií, záloh ani přihlašovacích údajů.

This text is an approval **template**, not an approval. If the owner-approved plan needs data import, migration, cache disposal or replacement, list each exact path and irreversible effect in a **separate** decision before implementing. Until then, all production flags remain off.

## Target-store provision and check (#422; no activation)

The operator selects an absolute **new, non-existing** target directory under an existing **trusted** parent and an explicit single owner ID. Every path ancestor must be owned by the operator's UID or root, and must not be writable by other users/groups unless it is a sticky-bit-protected directory owned by the operator or root (for example `/tmp`). Untrusted ancestors are refused for both provision and `--check`, because another UID could otherwise replace path entries between validation and filesystem writes. In addition, the target directory **and all three store files must be owned by the effective operator UID**: `--check` refuses foreign-owned 0700/0600 files even if run as root, because their owner could change them during preflight. Run `--check` as the account that owns the copy; do not use `sudo` to bypass ownership or automatically `chown` an unknown store. The CLI also refuses symlink/path aliases, overlap with configured legacy or existing target staging storage, and overlap with the implicit `<cwd>/.data` default. It bootstraps a private isolated store using the existing library, runs the supported **read-only** semantic preflight (schema, owner, restore generation, journal and witness) and publishes it only into a freshly created destination. It creates the directory with mode 0700 and the three store files with mode 0600. Re-running provision against an existing path fails without overwriting it. On a caught failure, the CLI removes only its own newly created working/output directories; a hard kill can leave an operator-private temporary directory that must be inspected.

**The execution account is part of the safety contract.** The deployed [systemd unit](../deployment/ai-executive.service) specifies `User=ai-executive`, `Group=ai-executive`, `WorkingDirectory=/opt/ai-executive` and `AI_EXECUTIVE_DATA_DIR=/var/lib/ai-executive`. The CLI creates files owned by its effective UID; `--check` accepts only that same UID. A target created by root cannot be read/written by the service, and a correct target created by the service will be rejected by a root `--check`. The root-only GitHub test uses **synthetic `/tmp` fixtures**, never a service target.

After **separate operator approval** of the exact new path, authenticated application owner ID, and private parent, confirm the loaded unit and invoke **both** commands using `runuser` as `ai-executive`. Capture both actual live data locations from the running process (including systemd `EnvironmentFile` and drop-in overrides) and pass them to the CLI; fail closed if that configuration is not available. Do not substitute known defaults. A one-time parent creation (only if absent, never overwrite existing) may be separately approved, e.g. `install -d -o ai-executive -g ai-executive -m 0700 /var/lib/ai-executive-target`. The candidate `/var/lib/ai-executive-target/personal-v1` is a **draft example, not approval**. The following block is a template **not to execute without authorization**; replace both placeholders.
```bash
# Run in an authorized root operator shell (bash; uses read -d '').
set -euo pipefail
test "$(id -u)" -eq 0
UNIT=ai-executive.service
SERVICE_USER="$(systemctl show "$UNIT" -p User --value)"
SERVICE_GROUP="$(systemctl show "$UNIT" -p Group --value)"
SERVICE_CWD="$(systemctl show "$UNIT" -p WorkingDirectory --value)"
test "$SERVICE_USER" = ai-executive
test "$SERVICE_GROUP" = ai-executive
test "$SERVICE_CWD" = /opt/ai-executive
test "$(systemctl show "$UNIT" -p DynamicUser --value)" != yes
SERVICE_UID="$(id -u "$SERVICE_USER")"
SERVICE_GID="$(id -g "$SERVICE_USER")"
test "$SERVICE_UID" -ne 0
test "$(id -gn "$SERVICE_USER")" = "$SERVICE_GROUP"

# The running process has resolved Environment=, EnvironmentFile= and drop-ins.
# Never log the environment (it can contain credentials), or shell-source it.
systemctl is-active --quiet "$UNIT"
MAINPID="$(systemctl show "$UNIT" -p MainPID --value)"
test "$MAINPID" -gt 0
test "$(awk '$1 == "Uid:" {print $3}' "/proc/$MAINPID/status")" = "$SERVICE_UID"
test "$(awk '$1 == "Gid:" {print $3}' "/proc/$MAINPID/status")" = "$SERVICE_GID"
LIVE_LEGACY_DIR=''
LIVE_STAGING_DIR=''
legacy_count=0
staging_count=0
while IFS= read -r -d '' entry; do
  case "$entry" in
    AI_EXECUTIVE_DATA_DIR=*)
      legacy_count=$((legacy_count + 1))
      LIVE_LEGACY_DIR="${entry#AI_EXECUTIVE_DATA_DIR=}" ;;
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=*)
      staging_count=$((staging_count + 1))
      LIVE_STAGING_DIR="${entry#AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=}" ;;
  esac
done < "/proc/$MAINPID/environ"
test "$legacy_count" -eq 1
test "$staging_count" -le 1
case "$LIVE_LEGACY_DIR" in /*) ;; *) echo 'STOP: invalid live legacy path' >&2; exit 1 ;; esac
case "$LIVE_STAGING_DIR" in ''|/*) ;; *) echo 'STOP: invalid live staging path' >&2; exit 1 ;; esac

TARGET_DIR='<approved-new-absolute-path>'
OWNER_USER_ID='<verified-application-owner-id>'  # NOT the POSIX service username
PARENT="$(dirname "$TARGET_DIR")"
test "$(stat -c '%u:%a' "$PARENT")" = "$SERVICE_UID:700"
test ! -e "$TARGET_DIR" && test ! -L "$TARGET_DIR"

# Preserve BOTH live paths in the CLI's overlap guards, without passing secrets.
cd "$SERVICE_CWD"
test "$(systemctl show "$UNIT" -p MainPID --value)" = "$MAINPID"
runuser -u "$SERVICE_USER" -g "$SERVICE_GROUP" -- env -i \
  PATH=/usr/bin:/bin HOME=/nonexistent \
  AI_EXECUTIVE_DATA_DIR="$LIVE_LEGACY_DIR" \
  AI_EXECUTIVE_TARGET_STAGING_DIRECTORY="$LIVE_STAGING_DIR" \
  /usr/bin/node scripts/target-store-provision.mjs "$TARGET_DIR" "$OWNER_USER_ID" --confirmed
test "$(systemctl show "$UNIT" -p MainPID --value)" = "$MAINPID"
runuser -u "$SERVICE_USER" -g "$SERVICE_GROUP" -- env -i \
  PATH=/usr/bin:/bin HOME=/nonexistent \
  AI_EXECUTIVE_DATA_DIR="$LIVE_LEGACY_DIR" \
  AI_EXECUTIVE_TARGET_STAGING_DIRECTORY="$LIVE_STAGING_DIR" \
  /usr/bin/node scripts/target-store-provision.mjs --check "$TARGET_DIR"

test "$(stat -c '%u:%a' "$TARGET_DIR")" = "$SERVICE_UID:700"
for name in lumi-target.sqlite lumi-target.journal lumi-target-witness.sqlite; do
  test "$(stat -c '%u:%a' "$TARGET_DIR/$name")" = "$SERVICE_UID:600"
done
```

**STOP on any mismatch.** The command reads only the two effective live storage paths from `/proc/$MAINPID/environ` and passes them into `safeTarget()` under the service UID. Never print the complete process environment (it can hold secrets), source `EnvironmentFile` as shell commands or hardcode a presumed live path. Confirm no separate service instance has another live storage location: the guard is scoped to this running unit. A root-owned/previously existing target must **not** be fixed with `chown`, reused, or overwritten; request a separately approved recovery procedure. For detached archival copies run `--check` as the account that actually owns that *copy*, never imply it establishes the service's access.

**Separate systemd sandbox gate:** the current unit has `ProtectSystem=strict` and only `StateDirectory=ai-executive`. The proposed external `/var/lib/ai-executive-target` lies outside the unit's declared writable directories. A successful `runuser` operation verifies POSIX ownership but **does not prove the running sandboxed service can write the target**. Before any runtime activation, obtain separate approval and verify a least-privilege `StateDirectory`/writable-directory change for the approved target; this PR neither changes the unit nor authorizes cutover.


A successful command prints **only** the three existing, exact settings:

```text
AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=/absolute/new/target-store
AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID=owner-user-id
AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=<UUID from this store>
```

Save those values in restricted operator evidence; do not publish the actual values in PR descriptions or enable flags. The final `--confirmed` is permission to create a **new empty store only**, not production cutover approval. `--check` never creates, repairs or alters any file; a failed preflight or unsafe permissions block further action. Neither command performs legacy import, migration, credential reset or deployment changes.

After creating the target in step 3a, **independently capture a coherent, protected offline copy of the complete recovery unit in step 4**, including both legacy and the target directory. If a legacy-only archive was previously taken, capture a new coordinated recovery unit; do not mix snapshots of unknown consistency. The archive/rehearsal required by #412 must then include it:

```bash
node deployment/rehearsal/cutover-restore-rehearsal.mjs \
  /offline/legacy-copy /new/rehearsal-output \
  --target-offline /offline/target-store-copy \
  --offline-confirmed
node scripts/target-store-provision.mjs --check /offline/target-store-copy
```

The rehearsal proves **byte/SQLite copy fidelity**, not journal/witness semantic validity or independent snapshot consistency. The separate `--check` provides the latter semantic preflight **only on the detached copy**, not cutover readiness. Before any deployment, still require owner approval, legacy/client/identity gates, verified independent backup/recovery, and exact-SHA release E2E.

## Copy-only rehearsal commands and limitations

Run on a **disposable/offline, previously quiesced snapshot only**, with destinations that do **not yet exist**. Never point these tools to a live server or run them as an agent on production. Both commands require a final `--offline-confirmed` operator assertion; this flag is **not proof** that a source is consistent, offline or non-production. They reject the app's implicit `<cwd>/.data` directory even when `AI_EXECUTIVE_DATA_DIR` is unset, as well as any explicitly configured live legacy/target paths. The shared root-aware containment predicate also rejects nested output under input `/` and handles symlink aliases of existing paths; never run a test against a real root directory. An operator running outside the service environment must independently identify **all** live storage locations, not merely rely on these guards. File-change checks and WAL/hash comparisons are insufficient to prove a coherent original snapshot under concurrent writers: the operator must first use an approved consistent snapshot or stop writers and verify the capture process independently.

```bash
node scripts/cutover-inventory.mjs /offline/legacy-copy /new/inventory-report --offline-confirmed
# Optional, after the operator has checked the *configuration* without exposing
# the actual secret: append --integration-token-present true|false
# immediately BEFORE the required --offline-confirmed flag

node deployment/rehearsal/cutover-restore-rehearsal.mjs \
  /offline/legacy-copy /new/rehearsal-output \
  --target-offline /offline/isolated-target-copy \
  --config-offline /offline/service-config-copy \
  --offline-confirmed

# A second, INDEPENDENTLY captured offline copy can be compared against the
# first copy, including its non-SQLite artifacts. The two input roots must
# resolve to distinct non-overlapping directories (no self-comparison,
# symlink aliases, parent/child inputs). This only validates path separation;
# the operator must independently attest separate, consistent captures.
node deployment/rehearsal/cutover-restore-rehearsal.mjs \
  --verify /offline/legacy-copy /offline/legacy-candidate /new/verify-output --offline-confirmed
```

**Inventory artifact safety:** The inventory report directory contains **only** `inventory.json` and `summary.txt` (both 0600), not `inspection-copy` or another SQLite file. During inspection, the CLI temporarily writes real private database/WAL bytes to a mode-0700 directory named `lumi-r4-inventory-*` under the operator's OS temporary directory (`TMPDIR`/platform temp location). **Before creating it**, the inventory checks the canonical temporary parent against the same known live legacy, target and implicit `<cwd>/.data` locations used for source/report safety; any temp parent inside a known live tree, including through a symlink, is refused. A general temporary parent containing a *separate* live subtree is permitted, because a fresh sibling scratch directory does not overlap that subtree. The check cannot discover unknown production paths when their environment configuration is absent. It deletes the scratch directory on success and caught failures. A hard process kill, system crash or cleanup failure can leave a private scratch copy. Operators must inspect report contents before sharing anything and securely clean abandoned scratch directories. Never share the whole temporary directory or a rehearsal archive as if anonymized.

**Verification semantics:** Default rehearsal mode archives and restores a **single offline source**; it establishes file and SQLite **copy fidelity only**, not an independent backup check. Console output says `SINGLE-SOURCE COPY FIDELITY VERIFIED (NOT independent verification)` and JSON has `verificationScope=single_source_copy_fidelity`. The `--verify` variant checks two separate input roots (`verificationScope=distinct_offline_inputs_equal`) but cannot prove independent, coherent capture; both modes report `independentCaptureEstablished=false`. `verdict=equal` means only that the compared objects match. An independent snapshot plus target security preflight and owner gates remain separate requirements.

**Privacy-safe errors:** The CLIs show explanatory, fixed operator messages for recognized argument/path, SQLite, integrity and copy-mismatch conditions (for example missing `--offline-confirmed` or an existing output destination). Native errors are mapped to allowlisted reasons. Raw exception text, source paths, private values and SQL are never printed; unexpected failures remain generic.

**Privacy and recovery metadata:** The public-facing `rehearsal.json` and console outputs contain no file paths, titles, identities, messages, arbitrary SQLite table names or secret values. In `lumi-r4-rehearsal-v3`, `rehearsal.json.tables` is a list of opaque ordinal IDs (`table_1`, `table_2`, ...) with counts and SHA-256 fingerprints, **not** an object indexed by source-derived SQLite table names (as in the former v2 report). Any downstream report parser must use this v3 format; the ordinal IDs are local to that run, not stable cross-run schema identifiers. Full table names, definitions and data remain solely inside the restricted archival SQLite copies for authorized inspection and integrity comparison. The rehearsal *archive, restored tree and inspection copies* retain the **actual** private contents, encrypted credential blobs and recovery artifacts; generated files are mode 0600 and directories 0700, owned by the operator running the rehearsal. Store the output in a protected operator-controlled location and do not commit or share it.

The **private** `archive/private-file-manifest.json` is mode 0600 and contains an entry for each original file/directory in each provided offline tree (legacy, optional target, optional service configuration, and optional verification candidate). Each entry includes its **original relative name, type, size, SHA-256 for files, original mode and UID/GID**, plus source-root owner and mode. These names are potentially personal and must never be uploaded as general PR evidence. Only the **SHA-256 of this private manifest** and content-tree digest are included in `rehearsal.json`. The manifest is essential for operator-only restoration and must be retained together with the archive.

**Restore/reconstruction rule:** Archival file copies are intentionally normalized to 0600/0700 to prevent disclosure; their original POSIX owners and permissions are **recorded but never automatically reapplied**. Byte-identical recovery is not an operational restore until an authorized operator validates the target service account/UID mapping and explicitly reapplies the recorded permissions/ownership in an isolated restored location. Never alter the archived copies, weaken archive permissions, or run an automatic recursive `chown`/mode restore during this rehearsal. Follow the approved retention and owner authorization policy.

The rehearsal (self-copy fidelity mode, not independent verification) compares all copied file contents byte-for-byte (including legacy backups, credentials and companion artifacts), records original filesystem ownership/modes **including each source root directory** in the private manifest, compares root and descendant metadata for `--verify` and before/after the source copy, verifies archived mode 0600/0700, checks all SQLite rows, SQLite `integrity_check`, `foreign_key_check`, all table/index/trigger/view definitions and sequence contents, and verifies `VACUUM INTO` as an additional complete SQLite archive. Row-digest computation fails closed above **200,000 rows per table** or **16 MiB per encoded row**; an oversized store is a blocker for this tool, **not** permission to skip its verification.

With `--target-offline`, the separate target directory must contain `lumi-target.sqlite`, `lumi-target.journal` and `lumi-target-witness.sqlite`. The archive restores their **bytes** and verifies both SQLite databases, but this does **not** prove journal↔witness↔target semantic consistency. A **separate supported target-store preflight, using only another offline copy**, must demonstrate the append-only journal, anti-rollback anchor, restore-generation and authorization invariants before owner approval. In particular, a mismatched target journal or witness blocks cutover even when directory hashes match. When the target flag is omitted, the report explicitly says `target.status = not_provided` and **cannot** be used as proof of a complete R4 recovery. External environment files and service credentials located **outside** the data directory require an independently obtained, protected offline copy passed with `--config-offline`. Otherwise `externalConfiguration.status = not_provided` blocks any claim of complete credential recovery. Its presence proves byte preservation, not login/service compatibility; test those independently.

The inventory reports actual legacy migration IDs only as a deterministic SHA-256 of the ordered list and compares them with the **pinned, ordered application catalog from `lib/schema-migrations.ts`**. A strict prefix is `known_older` and has a `legacy-migrations-N` version label; a complete exact match is `known_current`. An unknown/non-prefix set is `unknown` with no trusted version label, even when the migration count matches. This reference catalog must be reviewed and updated whenever the app adds migrations; CI compares it to the current source list. The inventory distinguishes `environment_not_inspected` (unknown integration-token presence) from an explicit operator-supplied boolean attestation. The machine cannot establish whether an environment-only secret exists by looking at the legacy SQLite file. Gmail sync inventory reports only aggregate checkpoint status and, when supported, `connectors.sync.reconciliationPending`: the **number of indexed Gmail message rows still marked `needs_reconcile=1`**. `0` confirms no flagged rows in the inspected schema; `null` means the field/table is unavailable and **must not** be interpreted as a clear backlog. `connectors.sync.status=complete` describes checkpoint-column coverage, **not** completed mailbox synchronization; inspect history/discovery pending counts and reconciliation independently. No mailbox IDs, subjects or message contents are printed. The separate `connectors.icloudSync` report provides allowlisted aggregate **stored** statuses for iCloud accounts and linked CalDAV calendar sources, plus earliest/latest successful-sync timestamps. Its `accounts` and `calendars` each have `schema=available` with numeric `total`/fixed-key `byStatus` counters (including `auth_failed`, `error`, `syncing`, `pending`, `ready`, `stale`, `other`) or `schema=not_available` with `null` counts if requisite tables/columns are missing. `0` means inspected and empty; `null` does **not** mean healthy. A stored `ready` state is **not** proof of currently fresh sync—interpret `lastSuccessAt` and check actual operator/service health separately. Only sources linked to an iCloud account with provider `caldav` are counted; independent ICS sources are excluded. No account IDs, calendar labels, error text, encrypted URLs or credentials enter the report or summary.

## Devices and client-held copies (manual, no automation)

The legacy browser uses IndexedDB database `ai-executive` (entities, relations, baseEntities, baseRelations). The isolated note-metadata path, when explicitly enabled, uses a separate IndexedDB `lumi-note-metadata-v1`; existing tabs and installed PWAs can preserve older copies and in-flight requests. No server-side tool can enumerate all private browser profiles, PWAs or offline devices.

1. Inventory each desktop/mobile browser **profile**, installed PWA, active and suspended tab, owner device and offline device; include last online time and a human acknowledgement. Do **not** collect browser cookies, credentials, record titles or cached contents.
2. Before an approved cutover, close/edit-freeze old clients. For every returning client, require reauthentication and a full reload from the server, confirm its trusted owner identity and restore generation, and never submit queued legacy full-snapshot writes. Keep devices offline or quarantined if the acknowledgement is missing.
3. Verify the legacy `x-lumi-restore-generation` barrier (and `baseRevision` on legacy PUT) and target generation/ACL barriers against stale requests, including BFCache restoration. A barrier check is **not** a remote wipe: an offline IndexedDB copy can remain on the device until the person clears or revisits it.
4. Before permitting edits, check there is no cached legacy row visible as an editable target row; verify logout/expired session clears sensitive rendered state. Do not automatically clear IndexedDB as part of #408.

## Rollback *plan*, not an executable command

Preserve both untouched archival sources and the exact deployed code/environment manifest. If an approved deployment later fails: stop all writers, prevent further client edits, record evidence and obtain operator authorization for restoring the **correct matching code + DB + journal/witness + secrets** as a coordinated unit. Target-staging restore is **not** a simple SQLite file replacement: its immutable journal, anti-rollback witness, revocation epochs and restore generation must be reconciled using the supported operator procedure. Never overwrite an existing directory or run the rehearsal as a rollback tool.

After recovery verify SQLite integrity, table counts/hashes against the selected archive, owner auth/revocation, target ACLs, same-origin guards, restore-generation fence and read-only legacy routes. Re-enable writes only after an explicit operator decision and client refresh. A failed archival restore or mismatch is a blocker, not a reason to bypass checks.

## Outstanding release gates

- #388: BFCache lifecycle evidence and stale-client fencing.
- #402: owner-session revocation one-time provisioning (no automatic missing-cutoff reinitialization).
- Exact-SHA release `Browser E2E`, separate from per-PR fast checks.
- Successful independent archival restore and owner sign-off.
- Decision on the production target store directory and how it is backed up together with irreversible journal/witness state.

**No real user data, production state or credentials were touched by preparing this document.**

---


## Appendix — C15/C17 Quick Capture BFCache release gate

**Status: NOT CERTIFIED.** This appendix implements [the owner's 2026-11-13
decision on #388](https://github.com/Kocooour/AI-executive/issues/388#issuecomment-6866991120),
the native harness [#425](https://github.com/Kocooour/AI-executive/issues/425)
and strict-mode alignment [#429](https://github.com/Kocooour/AI-executive/issues/429).
Neither an ordinary green PR run nor a synthetic lifecycle event is proof
of the **exact release SHA** gate.

The pre-production Quick Capture gate requires **both**:

1. **Native Chrome, automatically on the exact release SHA:** manual
   `workflow_dispatch` of **Focused R3 personal acceptance browser** with
   `target_sha` equal to the verified 40-character release commit. Its
   `NATIVE_REAL_BFCACHE_EVIDENCE` artifacts at **390 and 1280 px** must show
   the real initial and post-Back `pageshow` observations and one valid branch:
   - `evaluatedBranch: "not_restored"` / `persisted === false`: **nonempty**
     actual `Page.backForwardCacheNotUsed` reasons, a new document token,
     cleared draft and selected private Area, **zero** attempted
     `POST /api/target-staging/tasks`, a new direct completed authorized
     session GET 200 before reopening the editor, then a new authorized
     private Area GET 200 before reselection or Save. The abandoned text
     must remain absent and unsubmittable even after reopening and empty Save.
   - `evaluatedBranch: "restored"` / `persisted === true`: the **same**
     existing strict checks (original document token, no private text/Area
     restored, no CREATE, new completed direct session GET 200 **finished
     before** private Area GET 200 begins, both before any further action,
     and blank composer after reselection/Save). No relaxation of this path.
   Missing initial `pageshow`, no post-Back event, no reasons for a
   `not_restored` result, any leaked draft/selected Area or any CREATE **fails**.
2. **Safari, manually on the same deployed SHA:** one documented real
   Back navigation on a disposable staging instance in current Safari on
   **macOS or iOS**, recording the actual `pageshow.persisted` true/false and
   proving the private title and selected Area never remain visible or
   submittable. A restoration with leaked draft is a **blocking defect**.
   Follow section 3 and attach the filled evidence template.

**Privacy boundary:** keep `Cache-Control: no-store`, auth, cookies and ACL
unchanged. Do not simulate page lifecycle events, skip failed strict tests,
force BFCache eligibility, or relax checks to turn a miss into a pass.
Neither branch alone replaces full Browser E2E, separately verified full
reload / uncertain POST, backup/restore checks or explicit owner approval.
Quick Capture stays default-off until every R4 gate is met.

### C15 root-cause discovery: the earlier run could not exercise BFCache

The 2026-11-13 PR run for #427 logged `persisted:false` at 390 and 1280 px,
with `notRestoredReasons:null`. **This did not identify an application-level
blocker**: Playwright 1.56 starts Chromium with
`--disable-back-forward-cache` and `page.goBack()` cannot handle a genuine
BFCache thaw (see [Playwright navigation docs](https://playwright.dev/docs/navigations#backforward-cache-bfcache)).
The browser had no opportunity to produce the required real hit.

The corrected suite **does not remove `Cache-Control: no-store` or modify app
security**. The new `e2e/target-personal-native-bfcache.spec.ts` launches an
independent Chromium process without Playwright's BFCache-disabling switch.
It loads the actual isolated personal-v1 application using the disposable
owner session cookie, fills the real Quick Capture task form, performs a
cross-document navigation and the browser's native `history.back()`, and
records the original `pageshow.persisted`, private draft, selected Area,
and fresh authorized reads. This is NOT a synthetic transition.

After #429, manual exact-SHA strict mode accepts **either** genuine BFCache
restoration **or** an explained miss with complete privacy and fresh-read
proof. PR runs still exercise the native-browser code but are not release
certification.

Chrome may sometimes use BFCache with `no-store`, subject to privacy
exceptions (including changing cookies and `no-store` XHR responses).
Do not infer a universal browser limitation from one result. See
[Chrome's documented conditions](https://developer.chrome.com/docs/web-platform/bfcache-ccns).

#### Native Chromium PR evidence — 13 November 2026 (not a BFCache hit)

[Focused R3 personal acceptance browser, run 43511945915](https://github.com/Kocooour/AI-executive/actions/runs/43511945915)
finished **successfully** as an automatic PR workflow, but had
`LUMI_REAL_BFCACHE_E2E=false`: that green result demonstrates the fallback
and native-browser diagnostic harness, **not** the strict release gate.
It ran PR head `52a5e778e181832a3686a4dbefcd704c6cdd7358` through the
GitHub PR test merge checkout
`54dffa0d09442cca5b972c322fa4b3121a7c135d` (see
`checkedOutSha` in the log), **not** an exact candidate release-SHA dispatch.

The independently spawned **HeadlessChrome/141.0.0.0 on Linux** used native
`history.back()` on the real disposable `personal-v1` SQLite profile.
At **both 390 px and 1280 px** the original `pageshow` observer was active,
but the return had `persisted:false` and a **different document token**.
CDP `Page.backForwardCacheNotUsed` reported all three explanations:

- `MainResourceHasCacheControlNoStore` — **Circumstantial**
- `JsNetworkRequestReceivedCacheControlNoStoreResource` — **Circumstantial**
- `BrowsingInstanceNotSwapped` — **Circumstantial**

The document response was
`Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`.
These are **observed Chrome explanations**, not a proof that BFCache is
fundamentally impossible in all CI Chromiums, in other Chrome versions or
in Safari. Do **not** remove private `no-store`, disable auth, simulate
`persisted:true`, or treat a full reload as a hit. Keep #388 open.

Review [#5898604644](https://github.com/Kocooour/AI-executive/pull/427#pullrequestreview-5898604644)
also identified that checking resource *paths* alone could incorrectly
accept failed session/Area responses. The updated native witness instruments
CDP `Network.requestWillBeSent`, `Network.responseReceived`,
`Network.loadingFinished` and `Network.loadingFailed` **before navigation**.

On a true BFCache hit the existing witness requires **new completed direct
HTTP GET 200** responses for owner session and private Area in that order,
before any new user action. A `401`, `403`, `500`, aborted request, service
worker response or cached response does not qualify. CDP monitors
`Network.requestWillBeSent`, `responseReceived`, `loadingFinished`,
`loadingFailed` and cache flags before the initial navigation.

On an explained **miss**, a fresh document must prove the session GET 200
**before** opening a new editor; opening the task chooser can then trigger
the private Area GET 200, which must finish before reselection/Save.
Both paths check zero CREATE before/during Back, revalidation, reselection
and empty Save, with sensitive values excluded from logs. The positive-hit
path remains strict and unchanged by #429.

After merging #429, dispatch **both** scoped workflows once at the
integration-branch head as a **rehearsal only** and link the results to
[#388](https://github.com/Kocooour/AI-executive/issues/388). This is
not a release certificate: repeat on the actual release SHA and complete
Safari, full E2E, backup/restore and owner-sign-off gates separately.


### 1. Pin and run the scoped CI gates

1. Select the exact **40-character release commit SHA** (and workflow ref
   containing this gate). From GitHub Actions, dispatch **Focused R3 global
   private capture browser** with `target_sha` set to this commit, then
   dispatch **Focused R3 personal acceptance browser** with the same
   `target_sha`. Both use `LUMI_REAL_BFCACHE_E2E=true` for the native job.
   Each job checks `git rev-parse HEAD == target_sha`, uses a disposable
   personal-v1 SQLite store and test-only session, and records the SHA.
2. Collect both workflow URLs, job conclusions, checkout SHAs and browser
   versions. Download artifacts `lumi-r3-global-capture`,
   `lumi-r3-global-native-bfcache`, and `lumi-r3-personal-acceptance`.
   The `GLOBAL_CAPTURE_REAL_BFCACHE_EVIDENCE` and `REAL_BFCACHE_EVIDENCE`
   logs come from Playwright and **do not** certify a real restoration.
   The authoritative native evidence is `NATIVE_REAL_BFCACHE_EVIDENCE`
   (including `checkedOutSha`, `postBackObserved`, `evaluatedBranch`,
   `cacheNotUsed`, `recordedNotRestoredReasonCount`,
   `taskCreatePostCount` and `freshHttpReads`).
3. For **both 390 and 1280 px**, confirm a native observed initial and
   return `pageshow`, a valid `restored` or `not_restored` branch under
   the exact SHA, zero CREATE, cleared private title and Area, and fresh
   uncached authorized GET 200 evidence as described above.
   A missing/unknown branch or miss without actual CDP reasons **fails**.
   Ordinary PR runs can establish diagnostic coverage only.
4. **Separately** verify full Reload clears the draft, and the real-store
   `uncertain` POST scenario uses one original UUID pair, one committed
   CREATE, blocked replay after Reload and read-only receipt recovery
   **without a second CREATE**. Do not call this BFCache evidence.
5. Complete section 3's **Safari** check on the same staged SHA. A green
   native Chrome job **alone** never satisfies #388.

Scoped local reproduction on disposable data only:

```sh
LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E=true LUMI_REAL_BFCACHE_E2E=true \
  NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1 \
  pnpm exec playwright test e2e/target-personal-native-bfcache.spec.ts --project=desktop
```

Build the same checkout first; do not set `E2E_SKIP_BUILD=1` without a
verified matching build. Local tests alone cannot certify a release.


### 2. Diagnose Chrome non-restoration or missing evidence

A genuine cache miss with **nonempty** browser CDP reasons and all strict
privacy/wake checks is an **accepted `not_restored` branch**, not a
release-gate failure by itself. Record exact reasons, version, SHA,
document-token change and no-CREATE/fresh-GET proof. A miss without CDP
`Page.backForwardCacheNotUsed` reasons **fails**; do not use an empty or
unsupported `performance.navigation.notRestoredReasons` as substitute.
Keep the failure artifact, check observed response headers, page events
and native-CDP diagnostics. An unobserved initial or post-Back `pageshow`
is also a hard failure, never a skip.

Do not remove `no-store` or force the browser to restore. When a strict
job fails, #388 remains blocked. An explained and passing native miss
still requires the **independent Safari witness** in section 3 and the
remaining exact-SHA release gates.


### 3. Manual Safari through a disposable Linux instance and SSH tunnel (#456)

**Linux-only target store:** The target staging store uses Linux-specific pinned
file-descriptor semantics (`/proc/self/fd/N`). macOS cannot run the target store
safely. Do **not** port, weaken or bypass the pinned/journal code. Use a clean
single-use instance on the Linux server, running **as hermesadmin**, not as
`root` or the `ai-executive` production service account. Its new `lumi-e2e-*`
0700 directory lives under that user's `os.tmpdir()`; no live store, service,
credential or production environment is touched. Both Next and the TLS proxy
listen **only on 127.0.0.1**. Safari on the Mac reaches the proxy only through
an SSH local tunnel. This is the manual Safari release gate, not a deployment
or authorization to enable target flags in production.

**Resource caution:** This instance performs a fresh isolated production Next
build on the **production Linux server**. The build can temporarily consume
significant CPU and RAM; choose an appropriate low-load maintenance window
and stop if server headroom is insufficient. No public/LAN listener is permitted.

**1. Mac — issue and trust a loopback certificate from the Mac's own mkcert CA.**
Use Node 24 and mkcert on the Mac for certificate generation only. Install the
local CA in the Mac trust store if needed. Keep its CA private key on the Mac,
never on the server. Run the Mac preparation and transfer blocks in
the same shell; every block uses `set -eu` and **must stop at the first
failed command**. Do not run subsequent blocks after a failure.

~~~sh
set -eu
brew install mkcert                 # if not already installed
mkcert -install                     # Mac trust store; operator action
umask 077
MAC_TLS_DIR="$(mktemp -d)"
mkcert -cert-file "$MAC_TLS_DIR/safari-local.crt" \
  -key-file "$MAC_TLS_DIR/safari-local.key" 127.0.0.1 localhost
cp "$(mkcert -CAROOT)/rootCA.pem" "$MAC_TLS_DIR/rootCA.pem"
chmod 600 "$MAC_TLS_DIR/safari-local.key"
# NEVER copy rootCA-key.pem to the server.
~~~

**2. Transfer only three explicit files into a NEW operator-owned 0700 directory
on Linux.** Replace `<server>` with the actual SSH host. Do not transfer
`rootCA-key.pem`, a whole mkcert directory, production `.env` or any live data.
This step uses the `hermesadmin` SSH account.
The remote directory creation **and its ownership/mode check must succeed**
before `scp` is allowed to send any key material.

~~~sh
set -eu
SERVER="hermesadmin@<server>"
ssh "$SERVER" 'set -eu
  dir="$HOME/lumi-safari-tls-456"
  test ! -e "$dir" && test ! -L "$dir"
  umask 077
  mkdir -m 700 "$dir"
  test "$(stat -c "%u:%a" "$dir")" = "$(id -u):700"'
scp "$MAC_TLS_DIR/safari-local.crt" \
  "$MAC_TLS_DIR/safari-local.key" \
  "$MAC_TLS_DIR/rootCA.pem" \
  "$SERVER:lumi-safari-tls-456/"
ssh "$SERVER" 'set -eu
  dir="$HOME/lumi-safari-tls-456"
  test "$(stat -c "%u:%a" "$dir")" = "$(id -u):700"
  chmod 600 "$dir/safari-local.key"'
~~~

Stop if the destination already exists, is shared, is not operator-owned or
cannot be verified as 0700. The launcher rejects non-regular or foreign-owned
TLS files, symlinks, keys without **exact** 0600 permissions, certificates
without IP SAN `127.0.0.1`, certificates not signed by the supplied
`rootCA.pem`, and CA private keys even when renamed. All three TLS options
must be provided together, with the explicit `--port`. In this mode it does
not invoke mkcert. With no TLS options, its original local **Linux** mkcert
mode remains available, but the Mac is never a valid target-store host.

**3. Linux — clean disposable checkout, exact SHA, and isolated start.**
Run in the operator's home directory, **never in `/opt/ai-executive`**.
Use `hermesadmin`, never root or the production `ai-executive` account.
Do not source, copy or pass production environment files. The repository must
have no runtime `.env*` files or unsafe `.next` entries. The helper performs
its own sanitized exact-SHA Next build; do **not** run `pnpm build` separately.

~~~sh
set -eu
test "$(id -un)" = hermesadmin
test "$(id -u)" -ne 0
RELEASE_SHA="paste-the-approved-40-character-commit-sha"
git clone git@github.com:Kocooour/AI-executive.git "$HOME/lumi-safari-checkout-456"
cd "$HOME/lumi-safari-checkout-456"
git checkout --detach "$RELEASE_SHA"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
pnpm install --frozen-lockfile
TLS_DIR="$HOME/lumi-safari-tls-456"
env -i HOME="$HOME" PATH="$PATH" \
  node scripts/safari-gate-instance.mjs --port 3443 \
    --expected-sha "$RELEASE_SHA" \
    --tls-cert "$TLS_DIR/safari-local.crt" \
    --tls-key "$TLS_DIR/safari-local.key" \
    --tls-ca "$TLS_DIR/rootCA.pem"
~~~

Leave this terminal running. It must report **`HTTPS owner login + private
Area smoke: PASS`** before handing the URL to Safari; the smoke verifies the
CA-authenticated certificate, owner login/cookie isolation, the v1 shell marker
in the *served client page bundle* (not SSR HTML), and synthetic private
Area **Tvoření**. Capture the exact checkout SHA and printed test-only run
directory. A successful smoke is **not** the independent manual Safari witness.
On a failed smoke, stop; do not weaken TLS validation or switch to production
data. The launcher must be invoked from a checkout with its dependencies
already installed; it does not fetch packages during build. The explicit
`--expected-sha` is mandatory with external TLS: a clean checkout of the
wrong SHA is not a valid release witness, and the launcher rechecks this value
before the build and after the build.

**4. Mac — SSH tunnel and Safari.** In a separate Mac terminal:

~~~sh
set -eu
SERVER="hermesadmin@<server>"
ssh -o ExitOnForwardFailure=yes -N -L 127.0.0.1:3443:127.0.0.1:3443 "$SERVER"
~~~

The **local and remote tunnel ports must be identical** to the launcher
`--port 3443`, and the Mac endpoint must stay on `127.0.0.1`. Open the
**printed** `https://127.0.0.1:3443/__lumi_safari_gate__/fresh-origin`
in macOS Safari, with the tunnel active. Safari must trust the mkcert leaf
**without a warning**. A previously used origin can contain IndexedDB,
Cache Storage or service-worker state; the browser preflight must report
`LUMI_SAFARI_GATE_ORIGIN_CLEAN`. Otherwise STOP, remove **only the test
origin's** website data in Safari Settings → Privacy → Manage Website Data,
close previous test tabs and repeat. Never clear production Lumi data.
The per-run `__Host-lumi_safari_gate_*` cookie prevents cross-run reuse even
though cookies are host-scoped rather than port-scoped. Only after the clean
origin check, use **Pokračovat do testovací Lumi**, the printed one-time
password and Quick Capture's private Area **Tvoření**.

On macOS Safari go to **Safari → Settings → Advanced**, enable **Show
features for web developers**, then open **Develop → Show Web Inspector**.
In **Sources → + → Inspector Bootstrap Script** install the instrument
described in step 2 below and preserve console history before navigation.
An iPhone cannot reach the Mac's 127.0.0.1 tunnel automatically; iOS needs
a separately reviewed staging arrangement.

**5. Stop and delete only the exact disposable paths.** Press **Ctrl+C**
in the Linux helper terminal and stop the Mac `ssh -N` tunnel. Preserve
redacted release evidence first; never publish the one-time password,
private key or test-only private data. The helper intentionally **retains**
its printed `lumi-e2e-*` run directory, which the operator must inspect and
remove by its **exact printed absolute path** (no wildcard). Remove only
the dedicated `$HOME/lumi-safari-tls-456` directory and
`$HOME/lumi-safari-checkout-456` clone after verifying them, and delete
`$MAC_TLS_DIR` on the Mac. Do not delete any other files, saved backup,
service state, or production data. A fresh run must use new test credentials
and a newly verified checkout.

**Do once per release SHA, not once per PR.** Use test-only data and an
isolated authenticated staging instance, never production data. Record
the deployed/checked-out SHA, Safari version and device/viewport.
Use Safari on macOS, or Safari on iOS inspected remotely from a Mac.

1. Provision a real disposable target SQLite and a private Area, with
   exactly the `personal-v1` flags at the intended release SHA.
   Confirm the deployed SHA and owner session. Open **Safari Web Inspector**
   before the test (macOS: Develop → Show Web Inspector; iOS: inspect the
   connected device/tab from macOS Safari's Develop menu).
2. To capture **`persisted:false` even on a newly loaded document**, add
   a temporary **Inspector Bootstrap Script** in Web Inspector → Sources →
   create resource (`+`) → **Inspector Bootstrap Script**, using this code
   (see [WebKit's documentation](https://webkit.org/web-inspector/inspector-bootstrap-script/)).
   Unlike an ordinary listener typed into the console after load, this
   instrumentation runs when **each** new page global is created. Keep Web
   Inspector open and its console history preserved across navigation:

   ```js
   if (window.top === window) {
     window.addEventListener("pageshow", event => {
       if (location.pathname === "/") {
         console.info("LUMI_SAFARI_PAGESHOW", JSON.stringify({
           persisted: event.persisted,
           navigation: performance.getEntriesByType("navigation")[0]?.type ?? null
         }));
       }
     });
   }
   ```

   This merely observes **browser-fired** events; do not call
   `dispatchEvent` or create a fake `PageTransitionEvent`. Remove/disable
   this temporary bootstrap script after evidence capture.
3. Navigate the same tab **as a fresh document** to
   `/?view=Calendar&scope=personal`. Confirm the initial instrumented
   `LUMI_SAFARI_PAGESHOW` output with `persisted:false`. Open global
   Quick Capture (+), choose **Úkol**, explicitly select the test private
   **Oblast**, type a unique test-only private title and **do not Save**.
   Verify the draft and Area were selected before leaving (do not publish
   the private title in an issue).
4. Navigate within the same tab to `/robots.txt`, then use Safari's
   actual **Back** action. The inspector must show another **real**
   `LUMI_SAFARI_PAGESHOW` event for the application and its precise
   `persisted:true` or `persisted:false`; a missing observation is
   **inconclusive/fail**, not an inferred `false`. Record the value.
5. Immediately inspect the returned application's DOM and form:
   the abandoned title must be absent from all input values, DOM text
   and HTML, and the former private Area must **not** be selected.
   Inspect Network: **no** `POST /api/target-staging/tasks` across the
   full leave/Back/reopen process. Verify a fresh authorized
   `GET /api/target-staging/session`; after reopening Quick Capture and
   choosing Úkol, verify a fresh successful authorized
   `GET /api/target-staging/notes/create-targets` before Area
   reselection or Save. Reselect the same Area: the title must be
   **empty**; pressing Save must **not** create a task or revive the draft.
   A `persisted:true` result **with old text/Area or CREATE** is a blocking
   security defect. The same privacy checks are mandatory on `false`.
6. Run the full Reload scenario separately and verify an empty editor;
   this does not replace the Back check. Compare the independent
   real-store uncertain-POST CI receipt evidence. Record any unavailable
   Safari diagnostic as `not available` rather than inventing a CDP reason.

**Safari evidence template (one record per exact release SHA):**

```text
Release SHA / deployed SHA (must match):
Staging instance (non-sensitive identifier), owner/flag profile verified:
Safari version; macOS or iOS version; device and viewport:
Web Inspector bootstrap enabled; initial pageshow=false observed (yes/no):
Real Back pageshow.persisted (true / false / NOT OBSERVED):
Title absent immediately after Back (yes/no):
Old private Area unselected (yes/no):
New authorized session GET 200 (yes/no):
New authorized private Area GET 200 before reselection/Save (yes/no):
Reopened composer empty and unsendable (yes/no):
POST /api/target-staging/tasks count (must be 0):
Separate full Reload and uncertain-POST results/URLs:
Inspector evidence location (redacted); tester and timestamp:
Outcome PASS / FAIL / INCONCLUSIVE; blocking issue if any:
```

**Pass** only on an actual observed `true` or `false` with every private
data invariant met and zero CREATE. An event missing, leaking draft,
stale Area or automatic write is not a pass.

### 4. Closeout evidence for #388 and R4

Link both strict native Chrome workflow runs at the **exact release SHA**,
per-viewport `evaluatedBranch` and CDP reasons if `not_restored`, proof
of no stale title/Area or CREATE, fresh authorization, and the filled
manual Safari form with an actual `pageshow.persisted` result.
Attach separately the full-reload and one-UUID uncertain-POST checks,
full Browser E2E, verified backup/restore and explicit owner approval.
An automatic PR result or a successful integration-branch **rehearsal**
is never a substitute for these release-SHA steps. Keep #388 open
until **all** required conditions are satisfied and signed off.
