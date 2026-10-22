# Development workflow

This guide defines the local conventions for developing and testing Lumi in parallel. It supplements [AGENTS.md](../AGENTS.md); the canonical product requirements are in [PRODUCT.md](PRODUCT.md), UX/UI requirements in [UX-UI.md](UX-UI.md), and technical contracts in [ARCHITECTURE.md](ARCHITECTURE.md); [README.md](../README.md) is the index.

## Working conventions

- Keep `main` deployable. Every change starts in its own branch and is delivered through a pull request.
- Give every active implementation stream its own Git worktree or full checkout. Do not share a working tree between agents.
- Give every running development instance a distinct port and distinct mutable state.
- Never commit `.env.local`, database files, local storage directories, or credentials.
- Record the branch, port, local-state prefix, validation, and preview URL (when available) in the pull request.

Suggested names:

| Purpose | Branch | Worktree directory | Port | State prefix |
| --- | --- | --- | --- | --- |
| Stable baseline | `main` | `../lumi-main` | 3000 | `lumi_main` |
| Codex change | `codex/<ticket>-<topic>` | `../lumi-codex-<topic>` | 3001 | `lumi_codex_<topic>` |
| Claude change | `claude/<ticket>-<topic>` | `../lumi-claude-<topic>` | 3002 | `lumi_claude_<topic>` |
| PR preview/local check | `pr/<number>` | `../lumi-pr-<number>` | 30xx | `lumi_pr_<number>` |
| Integration test | `integration/<ticket>-<ticket>` | `../lumi-integration-<topic>` | 3010 | `lumi_integration_<topic>` |
| A/B option | `experiment/<topic>-a` or `-b` | `../lumi-<topic>-a` or `-b` | adjacent free ports | matching variant suffix |

Choose a meaningful, filesystem-safe `<topic>`. Do not reuse a port or state prefix while its instance is still running.

## Create isolated worktrees

Start from a clean, up-to-date clone:

```bash
git fetch origin
git worktree add ../lumi-codex-recurrence -b codex/42-recurrence origin/main
git worktree add ../lumi-claude-command-palette -b claude/51-command-palette origin/main
```

Install dependencies inside each worktree so its setup is explicit:

```bash
cd ../lumi-codex-recurrence
pnpm install --frozen-lockfile
```

List active worktrees before removing one:

```bash
git worktree list
git worktree remove ../lumi-codex-recurrence
git branch -d codex/42-recurrence
```

Only remove a worktree after its changes are merged or deliberately preserved elsewhere. Never delete a worktree containing uncommitted work.

## Isolate environment and local state

Copy the project’s environment template when one is available, or create an ignored `.env.local` per worktree. Use the same application settings needed by the feature, but change every writable resource.

Example shape (adapt variable names to the current application configuration; do not invent unsupported production variables):

```dotenv
# ../lumi-codex-recurrence/.env.local
PORT=3001
DATABASE_URL=file:./.local/lumi_codex_recurrence.db
LUMI_STORAGE_DIR=./.local/storage
LUMI_CACHE_DIR=./.local/cache
```

For this repository, SQLite is the canonical server-side store and browser IndexedDB is a local cache. Treat both as instance-specific during development. If the active configuration uses a different database, container, object store, upload directory, or service name, give it the same branch-specific suffix. Do not run migrations, cleanup jobs, seed scripts, or destructive tests against another branch’s state or production data.

Use synthetic test accounts and data for previews and local testing. Keep secrets in the local environment or the deployment provider’s secret store, never in a branch.

## Run parallel local instances

The development server accepts a port argument after `--`:

```bash
# main worktree
pnpm dev --port 3000

# Codex worktree
pnpm dev --port 3001

# Claude worktree
pnpm dev --port 3002
```

Open the corresponding local addresses, such as `http://localhost:3001`. Stop each process before reusing its port.

`pnpm dev` skips sign-in only when `AI_EXECUTIVE_AUTH_ENABLED=false` is set in the instance's ignored `.env.local`. A production build (`pnpm build && pnpm start --port 3002`) always enforces sign-in, so it needs a throwaway local `AI_EXECUTIVE_PASSWORD_HASH` (`pnpm --silent hash-password`, password on stdin) and `AI_EXECUTIVE_SESSION_SECRET`. In both cases point `AI_EXECUTIVE_DATA_DIR` at an instance-specific directory.

Run the standard PR checks from the affected worktree; run the complete browser suite voluntarily for risky changes or as the mandatory pre-deployment release check:

```bash
pnpm test        # unit tests in tests/*.test.mjs (Node test runner, no extra dependencies)
pnpm typecheck   # tsc --noEmit for the app, then for e2e/
pnpm build
pnpm test:e2e    # browser scenarios in e2e/ (Playwright, Chromium)
```

`pnpm test` covers deterministic `lib/` behavior only; it does not exercise the UI. Passing it is not evidence that a UI change was tested.

`pnpm test:e2e` builds this checkout, starts it on port 3100 with a temporary data directory and throwaway credentials, signs in once, seeds synthetic data and runs the scenarios in `e2e/` one after another against that instance: the Home brief, capture, the view in the address, a task link, the confirmation dialog, Settings sections, a lost connection and signing out. Its sign-in settings and data directory always come from the test run, never from an existing instance. Next.js still loads the checkout's ignored `.env.local`; the test instance therefore blanks the model provider key and the extra origins and sets the integration token to a random value of the run (the data-boundary scenarios present it to endpoints that must refuse it), and writes security alerts into its own temporary directory. A new variable that reaches an outside service must be added to that list in `playwright.config.ts`.

- The build goes into the checkout's `.next`, like `pnpm build`. Do not run the suite in a checkout that is serving an instance from `.next` at the same time (a `pnpm start` instance or the production checkout); use a separate worktree.
- First use on a machine: `pnpm install`, then `pnpm exec playwright install chromium` (`E2E_CHROMIUM=/path/to/chromium` uses an existing browser instead).
- One scenario: `pnpm test:e2e -g "part of its name"`. A failure prints the path of a trace; open it with `pnpm exec playwright show-trace <path>`. Traces of failed scenarios are kept in the checkout's ignored `test-results/`. The instance's data, session and credentials live in a private directory in the system temp directory that is removed when the run ends.
- `E2E_PORT=3105` picks another port when 3100 is taken by a parallel instance; `E2E_SKIP_BUILD=1` reuses the existing `.next` build of the same checkout; it does not notice source changes made since that build, so use it only right after a build.
- The scenarios share one instance and one session because sign-in is rate limited; add a scenario before the two sign-out scenarios, which must stay last.
- The suite covers the main paths only. It does not replace checking a UI change on the branch instance, and it does not cover a real calendar feed or a real iCloud account, passkeys, push delivery, drag and drop or an installed app. The iCloud calendar scenarios run against a local mock CalDAV server (`e2e/caldav-mock.ts`) on a random loopback port; the test instance gets `AI_EXECUTIVE_E2E=true` and `AI_EXECUTIVE_E2E_CALDAV_URL`, which only together, and only for a loopback `http://` address, make the server use it instead of iCloud.
- `e2e/` and `playwright.config.ts` are excluded from the app's `tsconfig.json`, so a production build does not need the test dependency. `pnpm typecheck` does need it.

Add and run focused automated checks when a feature introduces them. For UI-sensitive work, test desktop and narrow/mobile layouts on the branch instance; for persistence work, include a restart, migration/rollback (when relevant), and data-isolation check.

## Automatic pull-request checks (GitHub Actions)

The [PR Checks workflow](../.github/workflows/pr-checks.yml) runs for every pull request and on pushes to `main`. It installs locked dependencies, validates the deployment script syntax, runs `pnpm typecheck` and `pnpm test`, and builds with `pnpm build`. These checks and the required code reviews are the **PR merge gate**. The full Playwright/Chromium browser suite is **not required** for opening, reviewing, or merging each PR; it does not run automatically on PRs or pushes. For higher-risk UI/integration work, run focused browser scenarios or the full suite voluntarily on an isolated branch instance.

If GitHub's branch protection is unavailable or not enforced, manually verify (1) the current PR head and `main` SHAs; (2) successful complete `PR Checks` on the PR head; (3) required reviews and relevant integration/acceptance tests; and (4) a compare-and-swap head guard and successful merge. If the PR code or its integrated base changes, rerun the relevant PR validation. Never obtain a green result by skipping broken checks, weakening assertions or ignoring failures. Configure branch protection, where possible, to require **PR Checks**, not `Browser E2E`. Confirm that any ruleset is actually enforced; an unenforced one does not replace manual checks.

## Full browser E2E: mandatory production-release gate

The [Browser E2E workflow](../.github/workflows/browser-e2e.yml) runs via **manual `workflow_dispatch` only**. It is **mandatory immediately before deploying a release to the server**, not before each PR merge. Once all intended changes are merged into `main`, identify the exact 40-character SHA of `origin/main` that will be deployed. Dispatch the workflow on `main` (for example, `gh workflow run browser-e2e.yml --ref main`). Inspect the completed run and independently verify that its `head_sha` is **identical** to that target SHA. The pre-deployment check must complete successfully for all steps: locked dependency install, deployment-script syntax, `pnpm typecheck`, `pnpm test`, `pnpm build`, Chromium installation, and the entire `pnpm test:e2e` suite.

The workflow uses Node.js 22, pnpm 10, and the locked Playwright Chromium version. The CI E2E server binds to `127.0.0.1:3100` with temporary SQLite data, throwaway credentials, and loopback mock CalDAV; no production secrets or database are used. The production build is reused with `E2E_SKIP_BUILD=1` only after a successful build in the same job. Tests remain sequential because they share one seeded instance; do not enable parallel workers without redesigning fixtures. On failure, use the workflow logs and the `lumi-playwright-*` trace artifact (retained seven days).

An absent, pending, failed, cancelled, or incomplete `Browser E2E` run **blocks server deployment but does not block merging PRs**. If `main` advances after the release test, the candidate SHA changes: rerun the complete release gate on the new exact SHA before deploying. A successful browser run from an individual PR or an earlier `main` commit does not qualify a different release SHA. If the release suite fails, fix the issue in a new PR, merge it through the normal PR gate, and repeat the release E2E check. Keep deployment backup, rollback, service, database-integrity and HTTPS/auth-boundary checks unchanged. GitHub Actions validates an isolated candidate; it does **not** deploy Lumi or inspect the production database.

The full `pnpm test:e2e` suite remains available locally in an isolated checkout for debugging and targeted acceptance tests. It must not run against production state. Do not provide real credentials or production paths to either workflow.

## Review and integration workflow

1. An implementation author develops and validates the change in its own branch/worktree.
2. Open a pull request with the local reproduction details and, if supported, a dedicated preview deployment.
3. Request cross-review: Codex reviews Claude-authored work, and Claude reviews Codex-authored work. The reviewer independently checks acceptance criteria, regressions, edge cases, security/data boundaries, and the actual running instance or preview.
4. When two or more changes interact, create an integration branch from the current target branch:

   ```bash
   git fetch origin
   git switch -c integration/42-51 origin/main
   git merge --no-ff origin/codex/42-recurrence
   git merge --no-ff origin/claude/51-command-palette
   pnpm install --frozen-lockfile
   pnpm build
   pnpm start --port 3010
   ```

   Resolve integration conflicts and test the combined behavior, including the boundary between the features. Push the integration branch only when it is useful for shared review or CI; it is normally temporary.

5. Merge individual PRs only after their reviews, required **PR Checks**, and relevant combined validation have passed. The full Browser E2E suite is required later, before a server deployment, on the exact intended release commit. Delete temporary integration branches and worktrees only after the work is safely merged.

If infrastructure provides preview deployments, configure one isolated preview per PR. Use preview-specific environment values and test data, and put its URL plus any setup steps in the PR. A preview must not share a writable production database, storage bucket/prefix, scheduled-job identity, or notification credentials.

## A/B feature experiments

When the team is comparing two valid designs, create two separate branches/worktrees instead of mixing alternatives in one branch:

```bash
git worktree add ../lumi-command-palette-a -b experiment/command-palette-a origin/main
git worktree add ../lumi-command-palette-b -b experiment/command-palette-b origin/main
```

Run each variant with a separate port and state prefix, document the hypothesis and evaluation criteria, and compare the two instances or previews. Select one variant explicitly. Do not merge both alternatives unless their scopes are later made complementary.

## Pull request checklist

- [ ] Dedicated branch and isolated worktree/check-out used
- [ ] Unique port and local database/storage/environment prefix used
- [ ] Production build and relevant focused checks pass
- [ ] UI and persistence behavior tested where affected
- [ ] Independent cross-review completed
- [ ] Integration branch tested for interacting parallel changes, or not needed with a stated reason
- [ ] Preview deployment checked when available
- [ ] No credentials, local state, or generated mutable data committed
