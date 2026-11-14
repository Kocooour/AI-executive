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

The default deployment remains legacy-only: with no enabled target flag in the
root-owned env file, target preflight, target store reads, and target archival
steps are skipped. Generate the **proposed** exact flag block (not an activation
authorization) using \`node scripts/target-profile-env.mjs\`; fill the three
\`TARGET_PERSONAL_V1_REQUIRED_SETTINGS\` values from a separately approved
provisioned store and authenticated owner. \`node scripts/target-profile-env.mjs
--check /etc/ai-executive/ai-executive.env\` returns exactly \`off\`,
\`personal-v1\`, or \`invalid\` (nonzero on invalid), with only erroneous
variable **names**, never values. A partial profile or any enabled excluded
flag is refused before stopping the service. Every deployment also checks
the **loaded systemd environment sources** before stop: exactly the root-owned
`/etc/ai-executive/ai-executive.env` (non-optional) as the sole
`EnvironmentFiles` entry; the four expected fixed `Environment` assignments
from the deployed service unit; no `PassEnvironment`, `UnsetEnvironment`
or `PAMName`; and no target settings inherited from the system manager.
Unexpected sources fail closed even when the root env reports `off`.
The same source contract is rechecked before each target service start.
This is a restrictive launch boundary: operator drop-ins may add the
approved isolated `StateDirectory`, **not** any environment override.

**A separate written owner decision is mandatory before activation.** The
installed unit currently uses \`ProtectSystem=strict\` and writes only to
\`StateDirectory=ai-executive\`. The recommended isolated target
\`/var/lib/ai-executive-target/personal-v1\` requires a separately approved
systemd drop-in adding a second \`StateDirectory\`, followed by
\`systemctl daemon-reload\` and a reviewed service restart. Do not edit or
install that override on the basis of this PR. The deployment script refuses
target activation unless the **loaded** StateDirectory or ReadWritePaths
covers the target. Changing the versioned \`deployment/ai-executive.service\`
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

These tests are synthetic service mocks, not proof of a real deployment:
\`node --test tests/target-profile-env.test.mjs tests/deploy-safe.test.mjs
tests/reviewed-target-deploy.test.mjs\`. The exact release-SHA Browser E2E,
backup/restore rehearsal, systemd sandbox verification and explicit operator
approval are still production gates.
