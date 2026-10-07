# Lumi development workflow

These instructions apply to Codex, Claude Code, Hermes, and human contributors.

[README.md](README.md) is the canonical Lumi product, security, architecture, and operations specification. [docs/LUMI_PRODUCT_SPEC.md](docs/LUMI_PRODUCT_SPEC.md) is its index. [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) provide implementation and development guidance. When these sources conflict, preserve the README contract and ask for a product decision before proceeding.

## Product invariants

- Preserve **Tasks / Projects / Areas / Notes / Relations** as canonical records. Chat, imported text, claims, and model output are not canonical task state.
- Every mutation selects one explicit writable workspace. **All my work** is a read-only aggregate; do not permit cross-workspace reads, writes, relations, cached data, or search results.
- Prefer local-first behavior. Make pending sync, conflicts, freshness, and offline limits visible. Do not claim live calendar availability, delivery, or proactive activity when unavailable.
- AI may read authorized context, summarize, and prepare proposals. It must not bypass **proposal → explicit approval → revision-checked action → audit / guarded Undo**.
- Keep integrations behind adapters. Never expose provider credentials, raw imports, restricted context, or protected user data through clients, logs, backups, or model bundles.
- Choose the smallest understandable design that satisfies the task. Avoid unrelated refactors, duplicate state, premature abstractions, and unnecessary services.

## Shared-agent workflow

- Before changing a subsystem, read this file, the relevant README sections, and the affected code or documentation. Identify data ownership, API contracts, acceptance criteria, and migration or synchronization implications.
- Roles are complementary: Codex is suited to implementation and verification; Claude Code to independent design or review; Hermes to orchestration and scoped repository or integration work. A role never grants additional data access or approval authority.
- One scoped task belongs on one branch. Do not run multiple agents in the same checkout; use independent clones or Git worktrees. Resolve overlapping changes deliberately.
- Branch from current `main` using `docs/<topic>`, `feat/<topic>`, `fix/<topic>`, or `chore/<topic>`. Never develop directly on `main`, force-push shared branches, or modify another agent's branch without an explicit request.
- Open a pull request for every change. Include scope, product-contract implications, validation, risks or migrations, and follow-ups. Request independent review for security, data, integration, or deployment changes.
- Keep commits focused and reviewable. Preserve unrelated work. Never commit secrets, production data, backups, credentials, or raw user content.

## Quality gates

- Validate changes against the README product contract and the user's requirements. Inspect the final diff and exercise the changed path, including relevant failure, offline, authorization, and recovery cases.
- For application or source changes, run `pnpm build` at minimum, plus targeted tests when they exist or are added. Do not claim automated tests ran when the repository has no matching test command. Check responsive and accessible behavior for UI work.
- Before merging, review workspace isolation, authorization, data integrity, approval boundaries, error recovery, and regressions. Use an independent reviewer when available; otherwise record the tooling limitation in the pull request.

## Delivery boundary

A merged pull request is not authorization to deploy. Production deployment, credentials, migrations, live integrations, and destructive recovery actions require explicit user approval and the safeguards in the README. Do not weaken a failing check; report the concrete blocker.
