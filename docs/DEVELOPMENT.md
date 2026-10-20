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

Run the automated checks and the production build from the affected worktree:

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

## Automatic browser tests (GitHub Actions)

The [Browser E2E workflow](../.github/workflows/browser-e2e.yml) runs on every pull request, on pushes to `main`, and via manual dispatch. It checks TypeScript, runs unit tests, builds the production app and runs the complete Chromium Playwright suite against an isolated, throwaway app instance. The runner uses Node.js 22, pnpm 10, and Playwright's locked browser version. No GitHub secrets or production server are used; `playwright.config.ts` creates a temporary SQLite data directory, session secret and test user, and routes iCloud calls to a loopback mock.

The CI E2E server binds to `127.0.0.1:3100`. The production build is reused through `E2E_SKIP_BUILD=1` only after `pnpm build` succeeds in the same job. Tests execute sequentially because they intentionally share one seeded server; do not enable parallel workers without redesigning fixtures. On failure, inspect the job log and the `lumi-playwright-*` artifact (trace files in `test-results/`); artifacts are retained for seven days. Locally, use the isolated checkout procedure above and run `pnpm test:e2e`.

The CI job is a **verification gate**, not a deploy job. Branch protection / the required `Browser E2E` check must be configured separately in GitHub repository settings if merging should be technically blocked until it passes. Do not provide real API keys, calendar passwords or production database paths to this job.

## Required merge gate when branch rules are not enforced

The `Browser E2E` check is mandatory for **every** PR, including documentation-only changes. This is a project policy even if the repository's GitHub plan does not enforce protected branches or rulesets. Do not assume a saved ruleset is active: verify that GitHub reports its enforcement, or apply the following manual gate.

1. Fetch the current `main` SHA and the exact PR head SHA. Confirm that the PR includes the latest `main`; if `main` advanced since the test began, merge/rebase it into the PR branch and re-run CI on the resulting combined code (use an isolated integration branch for multiple interacting PRs).
2. Inspect the **latest complete** GitHub Actions `Browser E2E` run on that integrated code. Dependency install, typecheck, unit tests, production build and all Playwright tests must pass. An absent, pending, failed or cancelled essential step blocks merge; passing tests for an earlier commit or earlier base is insufficient.
3. Review any fixed E2E assertions to ensure they still verify the intended behavior. Do not skip, remove or weaken failing tests just to make CI green. If a check is unavailable, stop and report the blocker.
4. Only then merge with a guard against a changed PR head (for API merges, `expected_head_sha`), verify the merge result and ensure no untested changes entered `main`.

When supported, configure an **enforced** ruleset on `main` requiring pull requests, the GitHub Actions `Browser E2E` check, up-to-date branches, and no force pushes or branch deletion. In this private repository, enforcement may be unavailable under the current GitHub plan; manual verification remains compulsory until enforcement is independently confirmed. GitHub Actions does not deploy Lumi, and load tests must not run against the production SQLite database or application.

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

5. Merge individual PRs only after their reviews, required checks, and combined validation have passed. Delete temporary integration branches and worktrees only after the work is safely merged.

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
