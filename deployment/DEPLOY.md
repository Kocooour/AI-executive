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
