# Lumi development workflow

These instructions apply to every software-development task in this repository.

## Required model roles

Use the following four-role workflow for every development iteration, including bug fixes, refactors, UI work, integrations, security changes, and deployment preparation:

1. The primary strong model owns requirements analysis, solution design, architecture, validation against the canonical Lumi requirements in docs/PRODUCT.md, with UI acceptance in docs/UX-UI.md and technical contracts in docs/ARCHITECTURE.md, and the final decision on readiness.
2. Delegate implementation to one medium model. Prefer `gpt-6-sol` unless the task or environment requires another comparable model.
3. After an implementation is available, run two independent lightweight test agents in parallel. Prefer `gpt-6-luna`:
   - Tester A covers functional behavior, UX, responsive/mobile behavior, and acceptance criteria.
   - Tester B covers regressions, edge cases, security implications, data integrity, and failure recovery.
4. The primary strong model reviews both test reports, reproduces material findings when possible, coordinates fixes, and performs the final verification.

Do not treat an implementation as complete before both independent testers have reported, unless agent tooling is unavailable or a higher-priority safety/system constraint prevents delegation. If that happens, state the limitation explicitly in the final response and perform equivalent local checks.

## Parallel development and testing

- Give each agent or implementation stream its own branch. Prefer an isolated Git worktree or checkout per active stream so working files, dependencies, generated artifacts, and local process state do not collide.
- Run each local branch instance on a distinct port. Record the branch, worktree path, port, and local environment name in the task or PR description so reviewers can reproduce it.
- Isolate mutable local state for every parallel instance: database, file/storage directory, cache, upload directory, secrets/configuration, and any service/container names. Do not point two development instances at the same writable database or storage path.
- Keep shared credentials out of committed environment files. Base each instance on an ignored local environment file and use clearly branch-scoped names, for example `lumi_codex`, `lumi_claude`, and `lumi_pr_123`.
- When Codex and Claude work on related changes, request reciprocal cross-review: the non-author checks the implementation, tests, edge cases, data boundaries, and user-visible behavior independently.
- Before merging related parallel changes, create a temporary integration branch from the current target branch, merge or rebase the candidate branches into it, and run the relevant combined tests there. Resolve integration conflicts and regressions before merging individual PRs.
- If the delivery infrastructure supports it, use a separate preview deployment for every PR and include the preview URL plus any required test data/setup in the PR.
- For competing product or UX ideas, it is acceptable to implement two variants of the same feature on separate branches/worktrees. Label them as an A/B comparison, run them separately, and select one deliberately; do not merge both variants by default.
- Follow the concrete naming, worktree, port, environment, and test conventions in `docs/DEVELOPMENT.md`.

## Scope control

- Validate every iteration against the canonical Lumi product specification in docs/PRODUCT.md, relevant UX in docs/UX-UI.md and technical requirements in docs/ARCHITECTURE.md and the user's latest requirements.
- Preserve existing work and data. Do not remove or overwrite unrelated behavior.
- If a proposed change materially diverges from the canonical docs/PRODUCT.md specification or requires a product decision, ask the user before implementing that divergence.
- Testers must inspect the implemented result independently; they must not merely restate the implementation agent's report.
- The primary model remains accountable for the delivered result and must not accept agent findings without review.

## CI gates: pull requests vs. production deployment

- **Every PR** must pass the lightweight `PR Checks` GitHub Actions workflow for its current head: dependency installation, deployment-script syntax, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Reviews and relevant focused tests are also required. Full Chromium / `pnpm test:e2e` is **not a mandatory PR or merge gate**, including UI PRs; it may be run on demand when the risk or reviewer warrants it.
- Before merging, independently verify the current PR head and `main` SHA, the PR's successful `PR Checks` result, required reviews, and any relevant integration tests. A pending, failed, cancelled, or missing required PR check blocks merge. If the head or integrated code changes after validation, rerun the relevant PR checks against the changed code. Never bypass failures by disabling or weakening meaningful tests.
- **Before every deployment to the production server**, after merging the intended release changes, run the complete `Browser E2E` workflow manually (`workflow_dispatch`) against the **exact `main` commit SHA that will be deployed**. The release gate includes an explicit `target_sha` workflow input, verified checkout of that SHA, dependency installation, deployment-script syntax, `pnpm typecheck`, `pnpm test`, `pnpm build`, Chromium setup, and the entire `pnpm test:e2e` suite on synthetic, isolated data. Independently verify that the successful run's declared `target_sha`, `Verify exact E2E target SHA` step and recorded checkout SHA match the proposed deployment SHA; GitHub Actions `head_sha` identifies the workflow dispatch ref, which can differ from the checked-out target. A missing, pending, failed, or cancelled E2E run **blocks deployment, not merge**.
- To run the release gate, use `gh workflow run browser-e2e.yml --ref main -f target_sha=<40-character-main-SHA>`. This is a **human-enforced pre-deployment gate**: the production `deployment/deploy-safe.sh` script currently does not query GitHub Actions (no guaranteed authenticated `gh` client on the server). The operator must check the completed workflow and matching tested SHA **before invoking** that script. If the intended deployment SHA changes (including another PR merged into `main`), run the full release E2E workflow again for the new SHA. Never deploy a different commit using an earlier green run. If E2E fails, fix the issue via a PR and repeat the release gate; do not skip tests or relax assertions.
- **Migration of this CI policy:** Until the policy change has merged into `main`, the previous rules remain applicable to this transition PR itself: run full `Browser E2E` manually on the integrated transition branch with `gh workflow run browser-e2e.yml --ref codex/e2e-release-gate-only-20261022` (the branch-tip SHA fallback supports the legacy default-branch dispatch interface) and document its successful run before merging. A green `PR Checks` run alone does not retroactively waive the old rule.
- When GitHub branch protection/rulesets are available and enforced, require PR reviews, successful `PR Checks`, up-to-date branches when applicable, and prevent force pushes and branch deletion. Do **not** make `Browser E2E` a required merge status check. Verify enforcement independently; if unavailable on the repository plan, enforce PR and deployment gates manually.
- Use a compare-and-swap head SHA guard when merging through the API and verify the merged commit. CI uses isolated synthetic data and never deploys or tests against production state.

## Delivery policy

- Work in a dedicated branch and open a pull request for every change. Do not commit directly to `main`.
- A pull request must identify its branch, validation performed, and any required local/preview setup. For related concurrent work, it must also identify the integration branch or explain why integration testing is unnecessary.
- Merge only after the required reviews, final verification, and any integration testing have passed.
- After the merged change is ready for deployment, first require a passing full Browser E2E run on the exact deployment SHA as specified above; then preserve unrelated server changes, create and verify a recoverable database backup, use a fast-forward-only update, build the production application, restart it through the configured service manager, and verify the service, database integrity, authentication boundary, and configured HTTPS route.
- If credentials, server state, a failed check, or a destructive/conflicting condition prevents safe delivery, stop at that boundary and report the concrete blocker instead of weakening safeguards.
