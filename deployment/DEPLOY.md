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
checks. Ordinary failures can roll back code, **but a failed first rollout
introducing the owner-session cutoff must not automatically roll back to
pre-feature authentication**, because that old code would accept revoked
signed cookies. After the service has been stopped, a first-rollout failure
leaves it **stopped** and the current checkout unchanged by automatic rollback;
the operator must repair and redeploy a cutoff-aware version, or rotate
`AI_EXECUTIVE_SESSION_SECRET` before manually permitting the older code to
serve requests. Never recreate or restore the cutoff to make rollback work.
The script's path-independent absolute layout makes execution via stdin
equivalent to running the checked-out script **after** updating the checkout.

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
restart an old binary that would accept a pre-feature signed cookie. No real
production deployment or systemd commands run in CI.
