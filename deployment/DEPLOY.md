# Running the exact reviewed deployment script (including first rollout)

**Required entrypoint for every production release:** fetch the fully reviewed commit
on `origin/main`, then execute `deployment/deploy-safe.sh` **from that target
commit**, not the current on-disk checkout. The old deployed script cannot
contain a new feature's first-deploy migration/provisioning step. This matters
particularly for owner-session revocation, where a missing cutoff denies login.

Inside root's tmux session on the VPS, with the full reviewed commit SHA
as `TARGET_SHA` (already merged to `main`):

```bash
TARGET_SHA=<reviewed-40-character-main-sha>
sudo bash -c 'set -Eeuo pipefail; cd /opt/ai-executive; target="$1"; [[ "$target" =~ ^[0-9a-f]{40}$ ]]; git fetch --no-tags origin main; test "$(git rev-parse FETCH_HEAD)" = "$target"; git show "$target:deployment/deploy-safe.sh" | bash -s -- "$target"' _ "$TARGET_SHA"
```

The launcher first checks that `origin/main` matches the **exact SHA**. The
pinned script then performs its normal root-owned deployment lock, clean/main
worktree and ancestry checks, consistent backup, stop/build, first-time owner
cutoff initialization when appropriate, validation, restart and service
checks. Ordinary failures can roll back code. **If the first rollout fails
during the backup, before any code fast-forward or cutoff-initialization
attempt**, the unchanged pre-feature service is restarted only when the
checked-out commit is still the original one **and no cutoff file exists**.
The unverified backup is removed; after fixing the backup fault, rerun the
normal reviewed-SHA launcher. This path has not yet installed or initialized
the new authentication feature. If an existing cutoff is detected, restart
is refused even this early.

**If first rollout fails after the code switch begins or initialization could
have started, it is fail-closed:** the old pre-feature authenticator is not
restarted because it could accept revoked signed cookies. The service stays
**stopped** and the current checkout is not automatically rolled back.
Repair and redeploy cutoff-aware code through the guarded recovery procedure
below; alternatively rotate `AI_EXECUTIVE_SESSION_SECRET` before explicitly
authorizing any manual return to pre-feature authentication. Never recreate
or restore the cutoff to make rollback work.
The script's path-independent absolute layout makes execution via stdin
equivalent to running the checked-out script **after** updating the checkout.

### Recovering a stopped, cutoff-aware service after a failed first rollout

This is an **operator-controlled exception**, not a normal deployment path.
First investigate the incident, resolve the underlying build/service/HTTPS
failure, verify the original persistent cutoff is present, and confirm that
the active service configuration (including `AI_EXECUTIVE_SESSION_SECRET`)
has not been silently replaced. Preserve the existing verified backup. Before
resuming, require successful release Browser E2E for the **exact** intended
`origin/main` SHA, even if that is the same SHA already checked out.

From root's tmux session, execute the **reviewed target script** with the
explicit `--recover-stopped` argument:

```bash
TARGET_SHA=<reviewed-40-character-main-sha>
sudo bash -c 'set -Eeuo pipefail; cd /opt/ai-executive; target="$1"; [[ "$target" =~ ^[0-9a-f]{40}$ ]]; git fetch --no-tags origin main; test "$(git rev-parse FETCH_HEAD)" = "$target"; git show "$target:deployment/deploy-safe.sh" | bash -s -- "$target" --recover-stopped' _ "$TARGET_SHA"
```

If `systemctl is-active ai-executive` reports `failed` after a crashed
startup, inspect `systemctl status ai-executive` and
`systemctl show ai-executive -p MainPID -p ControlPID -p ControlGroup`
and verify **all** service workers are stopped. Only once that is confirmed
may the operator run `sudo systemctl reset-failed ai-executive`, then verify
`systemctl is-active ai-executive` reports exactly `inactive` before
invoking the recovery launcher. Never treat `failed` as evidence that the
workers stopped, and do not bypass the `inactive` guard.

This recovery mode requires an **inactive** service, a clean `main`
checkout already containing the cutoff-aware implementation, a cutoff-aware
reviewed target (same or newer commit), and a valid existing cutoff checked
read-only as the service user **before any backup/build/start**. It then runs
the usual locked, checked, backup-verified build and startup procedure. On
any failure it leaves the service stopped, never starts an old auth binary,
never silently initializes a missing cutoff, and never restores old cutoff
history. If state is missing/corrupt or the checked-out version predates the
feature, **stop**: this mode deliberately refuses recovery. Investigate and
follow the separate authorized first-provisioning or secret-rotation incident
procedure in [OWNER-SESSION-REVOCATION.md](../docs/OWNER-SESSION-REVOCATION.md).
Do not force a start or weaken these guards.

**Never substitute:**

```bash
sudo /opt/ai-executive/deployment/deploy-safe.sh "$TARGET_SHA"
```

That executes an **old** script for the whole release even if it updates
`main` midway. For the first owner-revocation deployment, this bypasses the
one-time cutoff setup and causes login HTTP 503. Do not repair a later missing
cutoff by rerunning `--init`: recover state or rotate the session secret
under operator control as documented in
[OWNER-SESSION-REVOCATION.md](../docs/OWNER-SESSION-REVOCATION.md).

The synthetic test `tests/reviewed-target-deploy.test.mjs` constructs an old
checkout and a newer remote main, executes this **documented command body**
against them, and checks that the new script runs while the local checkout
still contains the old one. `tests/deploy-safe.test.mjs` additionally
exercises a failed first rollout with real cutoff initialization in a
disposable mocked-service environment: it must preserve the cutoff and never
restart an old binary that would accept a pre-feature signed cookie. The
same fixture also covers a first-rollout backup failure **before** the
fast-forward (restart original service without provisioning cutoff, then
retry the full rollout), and rejects pre-feature restart when a cutoff file
already exists. It exercises the stopped-service `--recover-stopped` path with
a successful restart, rejects missing cutoff and pre-feature checkouts, and
verifies that a same-SHA recovery does not reset the cutoff. No real
production deployment or systemd commands run in CI.


### Target personal-v1 activation preflight (C14 / issue #424)

**C29 (decision 2026-11-16): the selected runtime profile is also a build
contract.** `personal-v1` MUST compile with
`NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1` (v1 shell and Quick Capture).
`off` MUST compile with that variable removed, including when it was set
in the operator's calling environment. `lib/target-personal-profile.ts`
is the canonical build-environment definition; the checked-out
`scripts/target-build-profile.mjs` performs both normal and rollback builds,
writes `.next/lumi-build-profile.json`, and verifies profile + BUILD_ID + SHA
before starting the service. Every `off ↔ personal-v1` change requires
a **new build via `deploy-safe.sh`**, not a process restart. The root-owned
EnvironmentFile must not assign any `NEXT_PUBLIC_*` key. A mismatched build,
unexpected dotenv shell switch, or manifest drift aborts before service start.
Do not manually restart a stale `.next` during a return to legacy.

The default deployment remains legacy-only: with no enabled target flag in the
root-owned env file, target preflight, target store reads, and target archival
steps are skipped. Generate the **proposed** exact flag block (not an activation
authorization) using \`node scripts/target-profile-env.mjs\`; fill the three
\`TARGET_PERSONAL_V1_REQUIRED_SETTINGS\` values from a separately approved
provisioned store and authenticated owner. \`node scripts/target-profile-env.mjs
--check /etc/ai-executive/ai-executive.env\` returns exactly \`off\`,
\`personal-v1\`, or \`invalid\` (nonzero on invalid), with only erroneous
variable **names**, never values. A partial profile or any enabled excluded
flag is refused before stopping the service. The deployment verifies that the loaded systemd unit uses the single mandatory
root-owned `/etc/ai-executive/ai-executive.env` EnvironmentFile; the env bytes
are SHA-256 fingerprinted and checked before service starts and off rollback.
Changes to the loaded file list or env bytes block unsafe restarts. No
manager-global environment, execution hooks, or complete hardening profile is
pinned: these fall outside the approved accidental-configuration-drift model.
**The sole loaded EnvironmentFile must not assign `AI_EXECUTIVE_DATA_DIR`,
`PORT`, `NODE_ENV`, `NEXT_TELEMETRY_DISABLED` or any `NEXT_PUBLIC_*`**, even to the expected
value: systemd's EnvironmentFile takes precedence over the unit's fixed
Environment assignments. This prevents the actual service from opening a
different store than the deploy script backed up and verified. A comment
mentioning a key is harmless. The check runs before service stop, before
start, and during any off-profile rollback.

The loaded unit must retain `ProtectSystem=strict` and
`StateDirectoryMode=0700`, with `ReadWritePaths`
either empty or exactly `/var/lib/ai-executive-security/outbox` (the approved
security-alert outbox only).
For `personal-v1`, it must expose exactly the baseline
`StateDirectory=ai-executive` plus the separately approved
`StateDirectory=ai-executive-target`, and the target directory must be exactly
`/var/lib/ai-executive-target/personal-v1`. Broader write paths and the
alternative single-StateDirectory mode are not authorized. With `off`, the
original unit or the approved second StateDirectory is accepted.
The existing preflight still checks the service user and working directory.

**A separate written owner decision is mandatory before activation.** The
installed unit currently uses \`ProtectSystem=strict\` and writes only to
\`StateDirectory=ai-executive\`. The recommended isolated target
\`/var/lib/ai-executive-target/personal-v1\` requires a separately approved
systemd drop-in adding a second \`StateDirectory\` and explicitly preserving
\`StateDirectoryMode=0700\`, followed by \`systemctl daemon-reload\` and a
reviewed service restart. Approved drop-in content:

```ini
[Service]
StateDirectory=
StateDirectory=ai-executive ai-executive-target
StateDirectoryMode=0700
```

The empty \`StateDirectory=\` also resets its mode to systemd's default
\`0755\` unless \`StateDirectoryMode=0700\` is set explicitly. That would
weaken permissions on both the legacy and target directories at restart.
After \`daemon-reload\`, **before** restarting, require:

```sh
test "$(systemctl show ai-executive -p StateDirectoryMode --value)" = 0700
```

Abort on a mismatch; correct the drop-in and reload it first. Do not edit or
install that override on the basis of this PR. The deployment script refuses
target activation unless the **loaded** approved isolated StateDirectory
covers the canonical target path, with `ReadWritePaths` empty or containing
only the exact approved security-alert outbox, and it rejects any weakening
of ProtectSystem=strict. Changing the versioned \`deployment/ai-executive.service\`
between release commits remains forbidden; a separately authorized operator
drop-in is distinct from changing that tracked file. See
[the cutover runbook](../docs/R4-CUTOVER-RUNBOOK.md) for a non-executable
proposal and the authorization gates.

With an independently approved, complete \`personal-v1\` configuration,
the reviewed target deploy script validates the profile and path ownership
before stopping. Only **after stop** does it execute the canonical
\`target-store-provision.mjs --check\` **as \`ai-executive\`**, comparing owner
and generation from the configured env. A running SQLite store can have
transient WAL/SHM files, so semantic inspection before stop is deliberately
unsafe. The script backs up the complete target directory alongside legacy
data and checks exact source/copy equality plus the common SHA-256 manifest.
**After copying, before any new service start**, it repeats the semantic
preflight and verifies the owner and restore generation are still identical
to the approved environment; a substituted but internally valid store is
rejected without serving requests. Since package installation and build
can be lengthy, the same owner/generation-bound semantic check runs **once
more immediately before the first service start** (still quiesced), after
all build and prestart snapshot work. If the store changed during that
interval, no target request may be served.
After startup it quiesces the service once more for a second semantic target
check, restarts, and repeats HTTP readiness. **Any failure after a
personal-v1 deployment has stopped the service leaves the service stopped.**
The rollback trap may restore the previous **code only**, but it MUST NOT
restart the previous binary: systemd would reload the still-enabled target
flags from the root-owned EnvironmentFile, even when semantic preflight
rejected that target. Neither target nor legacy data are restored or deleted.
Unverified incomplete backup directories alone may be removed. The operator
must first independently disable all target flags, validate `off` on the
effective EnvironmentFile, and follow a separately reviewed recovery/start
procedure. Do not blindly run `systemctl start` or assume that restoring
a previous git commit also restores the old process environment.

### C-3a Inbox schema upgrade (v26 → v27, issue #483)

From the C-3a activation release, the reviewed \`personal-v1\` profile also
contains the three Inbox flags \`AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED\`,
\`AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_WRITE_ENABLED\` and
\`AI_EXECUTIVE_TARGET_UI_INBOX_ENABLED\`. An env file without them is a
**partial profile** and the deployment stops *before* stopping the service;
add the three lines (owner-approved env change) before running the release.

Inbox needs the target schema v27. The application **never** migrates on
startup. For \`personal-v1\`, \`deploy-safe.sh\` runs the explicit
\`scripts/target-staging-upgrade-inbox.mjs --apply\` as \`ai-executive\`
exactly once per deployment, **after** the verified combined archive and the
build, with the service stopped, after one more owner/generation-bound
semantic check and **before** the first start; then \`--check\` must report
the current v27 schema, followed by the existing pre-start and post-start
checks. The upgrade is idempotent: an already-v27 store is a no-op (later
deploys). Any other state, a failed write, or an unconfirmed commit aborts
and the **service stays stopped** (personal-v1 failure rule above).

**Rollback.** Code built before C-3a does not read v27. After an attempted
upgrade, a return to earlier code is only possible by an **owner-approved
restore of the archived v26 \`target/\` directory** from the deployment's
verified backup (\`/var/backups/ai-executive/deploy-*/target\`, checked
against its \`SHA256SUMS\`), with the service stopped and target flags
handled per the recovery procedure. The script never restores or deletes
target data by itself. Operator command to inspect without writing:
\`runuser -u ai-executive -- env AI_EXECUTIVE_DATA_DIR=/var/lib/ai-executive
node --experimental-loader ./scripts/target-staging-ts-loader.mjs
scripts/target-staging-upgrade-inbox.mjs --check --directory <dir>
--generation <generation>\` (status JSON only, no values).

These tests are synthetic service mocks, not proof of a real deployment:
\`node --test tests/target-profile-env.test.mjs tests/deploy-safe.test.mjs
tests/reviewed-target-deploy.test.mjs\`. The exact release-SHA Browser E2E,
backup/restore rehearsal, systemd sandbox verification and explicit operator
approval are still production gates.


## C34 — Verify allowed public Origin before target write release

Tailscale Serve terminates HTTPS externally and forwards the request to
Next on loopback. Target write endpoints **must** recognize the exact browser
origin through `AI_EXECUTIVE_ALLOWED_ORIGINS`, just like legacy endpoints.
Without that setting writes can fail as `403 Cross-origin request rejected`
even while target reads return 200.

Before approving a release, inspect the effective **root-owned service
environment** (locate its EnvironmentFile via `sudo systemctl cat ai-executive`).
Confirm that `AI_EXECUTIVE_ALLOWED_ORIGINS` contains the exact public
scheme, host and optional port used by the browser, e.g.
`https://vm13861.tail412944.ts.net`, comma-separated if multiple origins
are intentionally supported. Do not use `*`, URL prefixes or paths, and
do not base the decision on `X-Forwarded-Host` or other forwarded headers.
Check the setting without printing unrelated secrets from the environment.

The PR/release gate must include the unit tests, real-handler task CREATE
and note preview tests, and the isolated-store browser proxy variant in
`r3-personal-acceptance-browser.yml`. The proxy variant is synthetic: it
does not modify production. After owner-approved deployment, verify target
preflight and normal browser task creation via public HTTPS with an
authenticated owner session; a refused, unlisted `Origin` must still yield
403. Do not use a production write as an automated CI probe. Perform the
normal exact-SHA release gate and owner-controlled deployment procedure
above; this fix does not authorize a direct production change.


### C-3b consent fence outside restore and rollback after first write (PR #492)

**Operator env change BEFORE the first deploy:** add the single required line
`AI_EXECUTIVE_TARGET_STAGING_HTTP_C3B_ENABLED=true` to the root-owned
`/etc/ai-executive/ai-executive.env` alongside the rest of the complete
`personal-v1` profile. An older env without it is an invalid partial profile:
`deploy-safe.sh` refuses it before service stop. No separate activation PR
or post-deploy manual first consent is required. Without `OPENAI_API_KEY`,
Inbox uses deterministic local rules, not a failing remote provider.

**Revocation/rollback:** The Settings switch may revoke consent and later
re-grant only after a fresh explicit owner action. Neither a later deploy,
service restart, restore of `target/`, nor a missing first-grant row can grant
again. Keep the newest outside-restore fence even when restoring an older
target backup. A mismatch stops deployment; fix only through an explicitly
reviewed operator procedure, never by deleting receipts/decisions or restoring
an older fence.


**Approved production location:** `/var/lib/ai-executive-target/inbox-ai-consent-fence.sqlite`.
This is inside the existing `StateDirectory=ai-executive-target` under
`ProtectSystem=strict`, but strictly **outside** the restorable
`/var/lib/ai-executive-target/personal-v1` target store. There is no new
systemd `ReadWritePaths`, no change to the unit sandbox, and no HTTP-created
SQLite file. The standalone fence contains only actor/decision IDs, revocation
epochs, pending cross-process dispatch tickets and budgets; no private task
titles, AI prompts or responses. It is owned by `ai-executive`, mode 0600.

**Deployment step:** after the verified backup and while the service is
stopped, `deploy-safe.sh` performs the C-3a idempotent v27 check/upgrade,
then (on the *first* reviewed C-3b code rollout only) runs
`scripts/target-inbox-ai-fence-provision.mjs --provision --directory
/var/lib/ai-executive-target/personal-v1` **as ai-executive**. It then
always runs the same command with `--check` before starting the service.
Only on the **first reviewed C-3b rollout with a missing external fence**, the
owner-approved deployment then calls `--first-grant` with the configured owner
and restore generation. The command journals one `inbox_consent` grant in the
canonical pinned target v27 write path, then records the same first decision,
epoch 1 and scope `c3b:v1` in the separate fence. It emits no private data.
The final `--check --directory ... --owner <ID> --generation <UUID>`
requires **strict agreement of both durable stores** (including a matching
disabled/revoked state). On subsequent **ordinary** deployments only `--check` runs:
no new grant, repair or reset of decision history is ever automatic.
The only exception is an explicitly owner-approved `--recover-stopped
--recover-first-consent` after a documented incomplete first grant, subject
to the original root-owned proof and empty consent/revocation history below.
For an **OFF/OFF** state only, a partial failed re-grant followed by a
confirmed revoke can leave the target's older owner-decision ID different
from the external fence's latest re-grant decision. A later read-only deploy
check permits this exact case only when both stores are disabled, their
epochs/generation/scope agree, and the target decision is in the fence's
immutable history at or before that epoch. An enabled grant still requires
the current decision IDs to match. No check repairs, rewrites or re-grants
either store; stale epochs and restored older ON snapshots remain blocked.
A crash between target and fence commits means AI stays disabled and the
service stays stopped until operator-reviewed recovery; no old code may
restart on the updated target. A missing, symlinked, wrong-owner/mode,
corrupt or mismatched fence aborts the deploy. A missing fence after the
first rollout is never recreated, and a revoked owner remains revoked.
The original owner decision is #471, reconfirmed in #492 on 2026-11-23.

**Interrupted first grant — stopped-service recovery (P2).** When the
first reviewed C-3b rollout has already created
`/var/lib/ai-executive-target/inbox-ai-consent-fence.sqlite`, but
`--first-grant` fails before both stores agree, the deployment leaves the
service **stopped** and deliberately retains the **consent-aware checkout**
(no code-only rollback to a version lacking C-3b), so the reviewed recovery
entrypoint can safely verify both stores. It preserves a root-only, mode 0600 proof at
`/var/backups/ai-executive/.inbox-ai-first-consent-pending`. This proof
is written only after successful first-time provisioning, *before* the first
grant, and records the owner, restore generation and device/inode of that
specific external fence, including its SHA-256 content digest before
any grant. Successful grant and read-only two-store `--check`
remove it **before the first service start**.

The ordinary deploy and ordinary `--recover-stopped` modes MUST NOT grant
consent. Only after the operator has checked the original verified backup,
confirmed the first grant was interrupted, confirmed that the protected
external fence file has **not been replaced**, and confirmed the service and
all workers are stopped, the operator may explicitly run the reviewed SHA's
deploy script with `--recover-stopped --recover-first-consent`:

```bash
TARGET_SHA=<reviewed-40-character-main-sha>
sudo bash -c 'set -Eeuo pipefail; cd /opt/ai-executive; target="$1"; [[ "$target" =~ ^[0-9a-f]{40}$ ]]; git fetch --no-tags origin main; test "$(git rev-parse FETCH_HEAD)" = "$target"; git show "$target:deployment/deploy-safe.sh" | bash -s -- "$target" --recover-stopped --recover-first-consent' _ "$TARGET_SHA"
```

This path requires **all** the ordinary stopped-recovery protections
(unchanged persistent owner-session cutoff, exact SHA, verified backup,
read-only target checks and the original environment), a consent-aware
previous checkout, the original private existing fence, the valid root-owned
proof with matching owner/generation/device+inode/SHA-256, and an independently
verified empty fence grant/decision/pending/**budget** history. The target
consent must be absent or exactly the original enabled epoch-1 decision
`owner-2026-11-19-issue-471`. A prior revoke, foreign decision, partial
regrant, stale generation, used provider budget, missing/corrupt proof,
missing/replaced fence or damaged history is a **hard stop**, never an
opportunity to recreate the DB or infer a new owner approval.

If provisioning itself failed before the proof was durably recorded,
or the proof cannot establish continuity of the original file, **do not**
manufacture a new proof or delete old history. Follow a separate approved
incident recovery. An empty database by itself is not evidence that no
grant/revoke has ever occurred. This recovery does not authorize a production
release without the usual exact-SHA tests and owner sign-off.

**Backup and restore:** if an existing fence is present at deploy time, the
root-only deployment archive includes a byte-for-byte diagnostic copy and
checksum `inbox-ai-consent-fence.sqlite`; this archive is **not** an
authorized restore source for the fence. On restoring older
`target/` from backup, **leave the latest external fence in place**.
Any restore-generation or consent-epoch mismatch disables AI, requiring a
new explicit owner decision. Never copy an older fence from the archive over
a newer revoked fence: that would replay consent. Keep any crash/orphaned
pending dispatch tickets until manual safe reconciliation, not automatic
TTL deletion. Never write a grant during ordinary recovery or restart.
The tightly scoped, proof-bound **first-grant-only** exception is below.

**Older code rollback:** C-3b introduces target metadata namespaces
`r3:c3b:*` and journal kind `inbox_consent`. Once **any C-3b
metadata/journal write** has happened, older code such as
`443c17df6376c8e886150d45bcc6bcb2457b2a94` cannot safely read the
current v27 target, even though the schema version number is unchanged.
Rolling back **code only** is insufficient. Stop the service; restore
`target/` only from a verified **pre-C-3b-write** archive with explicit
owner approval and matching integrity/generation checks. Keep the latest
external fence outside this restoration and verify AI remains disabled until
reconsent. Never downgrade live SQLite schema, erase C-3b metadata manually,
overwrite the fence, or silently roll back consent. If a safe archive is not
available, keep the service stopped and roll forward to fixed C-3b-aware code.

**Compatibility control:** a current, untouched production v27 store with no
`r3:c3b:*` metadata must continue to pass
`target-store-provision.mjs --check` and the read-only preflight without
migration or modification. C-3b now writes owner consent during the explicitly approved first
deployment (decision 2026-11-23), using the standard pinned target journal.
The owner-approved activation MUST still pass exact-SHA tests, release QA
and deployment authorization. An unmodified v27 store remains read-compatible
before that deployment.


### C-3b durable Inbox receipt capacity (owner maintenance)

The canonical C-3b metadata receipt limit is **65,536 rows** (raised from
4,096), reserving one future Undo slot for every active Accept. Thus a
pure Accept workload supports 32,256 new decisions before its bounded limit;
already completed Undo consumes only its reserved slot. A separate 1,024-slot emergency reserve protects terminal cancellation after new
Accept admission is exhausted. Permanent terminal cancellations consume rows. The writer and canonical read-only preflight
share `C3B_RECEIPT_MAX_ROWS`, so a partially upgraded application fails closed.

**Read-only capacity inspection** against a stopped, backed-up target SQLite
store (never output metadata values or private IDs):

```sql
SELECT COUNT(*) AS receipts FROM metadata
WHERE key LIKE 'r3:c3b:accept:v1:%' OR key LIKE 'r3:c3b:undo:v1:%';
SELECT COUNT(*) AS active_accepts FROM metadata AS a
WHERE a.key LIKE 'r3:c3b:accept:v1:%'
  AND json_extract(a.value,'$.kind')='accept'
  AND NOT EXISTS (SELECT 1 FROM metadata AS u WHERE
    u.key='r3:c3b:undo:v1:' || substr(a.key,length('r3:c3b:accept:v1:')+1));
```

At **49,152 reserved slots (75%)**, schedule a reviewed, nondestructive
capacity upgrade, increasing *both* writer and preflight limits, with
verified backups and exact-SHA test/restart acceptance. Reservation =
`receipts + active_accepts`. No automatic expiry or deletion of accepted,
undone or cancelled UUIDs: the immutable history prevents replay and supports
old Undo. New Accepts stop before the emergency cancellation reserve is consumed; receipts
and already reserved Undo stay valid, and cancellation remains available while
emergency slots exist,
and manual Inbox triage remains available. Never reset the ledger, discard
old tombstones, bypass preflight or silently shrink historical records.


**Operator-visible headroom (C-3b Settings):** the authenticated owner-only
`GET /api/target-staging/inbox/c3b/consent` now includes exact numeric
`capacity.{used,reserved,limit,remainingAccepts,warning}` from an independently
pinned, read-only canonical database snapshot. Settings renders a visible 75%
warning without exposing receipt keys, UUIDs, task IDs or private content.
The server's frequent post-AI-release consent check skips these expensive
headroom calculations; they are only retrieved on an explicit Settings or
consent-refresh read. This is a human-visible owner warning, NOT an
always-on notification or automated destructive maintenance operation.

**Grow-only upgrade rehearsal:** before any future capacity expansion, take
verified pre-upgrade backups. Test canonical validation with **more than the
old 4,096 immutable tombstones**, verify no old UUID can be accepted after
cancellation, and reject any ledger above the new bound. Increase writer and
read-only preflight limits in the same reviewed release while preserving the
1,024 terminal-cancel reserve and one Undo per active Accept. Run exact-SHA
C-3b real-store/owner/restore acceptance and verify both the complete
receipt count and original receipt outcomes in an isolated restored copy.
Do not code-only rollback to a lower ceiling once new receipts exceed it;
roll forward with compatible code. Never recycle, reset, truncate or
re-key receipt history.


**Nouzové vypořádání osiřelých AI požadavků (P2):** Pokud revokace po
pádu workeru trvale čeká na starý ticket, nikdy jej automaticky nemažte při
startu ani z webového požadavku. Nejprve bezpečně zastavte systémovou službu
`ai-executive` a ověřte její stav `inactive` (včetně všech child workerů).
Až po uplynutí nejméně 30 s od vzniku všech zbývajících ticketů může
autorizovaný operátor jako uživatel `ai-executive` výslovně spustit:

```sh
sudo systemctl stop ai-executive
sudo systemctl show -p ActiveState --value ai-executive
sudo -u ai-executive env LUMI_INBOX_AI_RECONCILE=1 \
  /usr/bin/node --experimental-loader \
  /opt/ai-executive/scripts/target-staging-ts-loader.mjs \
  /opt/ai-executive/scripts/target-inbox-ai-reconcile.mjs \
  --reconcile-stopped \
  --directory /var/lib/ai-executive-target/personal-v1 \
  --owner '<ověřené OWNER_USER_ID>' \
  --generation '<ověřené RESTORE_GENERATION UUID>' \
  --expected-epoch '<aktuální fence epoch>'
```

Před spuštěním zvolte přesné hodnoty z ověřeného produkčního profilu a
nezávislé fence; nikdy je neodvozujte z browseru ani z obnovené zálohy.
Příkaz odmítá běžící/neznámý stav služby a příliš mladé požadavky,
zvyšuje revokační epochu a přes canonical pinned journal zapisuje
odpovídající **vypnutý** cílový souhlas. Pokud druhý zápis selže,
služba musí zůstat zastavená pro ruční nápravu. Po úspěchu znovu ověřte
shodu obou databází `--check`, teprve pak připravte samostatně schválený
restart. Neobnovujte starou fence z target backupu a nikdy neprovádějte
automatické opětovné udělení souhlasu.
