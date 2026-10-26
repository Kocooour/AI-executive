# R1 (part 1) — isolated clean-start target SQLite bootstrap

**Status:** preparatory backend foundation, not active in Lumi and **not** a production migration, reset or cutover. Implements the first small part of [R1 in the roadmap](ROADMAP.md) after PR #126.

## What exists

`lib/target-store-bootstrap.ts` exports `bootstrapIsolatedTargetStore({ stagingDirectory, ownerUserId })`.

- The caller must supply an **absolute path to a directory that does not exist**. Its parent must exist. A symlink-aware check refuses targets which overlap the live `AI_EXECUTIVE_DATA_DIR` (including its default). Existing directories are never reused or overwritten.
- The call creates a new directory and `lumi-target.sqlite`. On failure it leaves any newly created staging directory for explicit investigation; it **never** removes any existing state.
- The isolated schema begins with one owner identity, one internal personal workspace and the owner's private system Area `Nezařazeno`. No user tasks, projects, integrations, tokens, or old database rows are read or imported.
- Schema metadata includes `activated=false`, `write_protocol=per-item-only` and a new `restore_generation`. These are markers for the future R2 protocol, **not** an active gate in the existing application.
- Database constraints distinguish private Areas in personal workspaces from shared Areas in dedicated shared internal workspaces. R1 enforces **at most one** shared Area per internal workspace; R2 must validate the complete 1:1 mapping and at least one active admin per shared Area before activation. Tasks contain **either** a standalone Area **or** a project ID; project tasks inherit their effective Area through a view. Optional assignees must be current `editor` or `admin` members of their shared Area. R1 rejects Area changes for existing projects until R2 implements confirmed, audited moves, and guards assigned members and private boundaries against conflicting SQLite writes.
- No module imports this bootstrap into startup, routes, sync, UI or scheduled jobs. No production database, current Dexie schema, release flag or API behavior changes.

## Expected follow-up before any activation

This module is **not** the server authorization layer. R2 must implement verified identities and sessions; per-item Area-scoped commands; transactional membership, ownership and secure revocation; an independently authorized read model; protocol/restore-generation barriers for all legacy full-snapshot clients; cache isolation and offline recovery; and negative multi-identity integration tests. R1 must also validate remaining write pathways before R3 UI activation.

In particular, creating the isolated database does **not** authorize a destructive cutover. Separately inventory live/auth/integration/offline data, verify consistent archival backup and restore, and obtain explicit owner approval for a precisely defined production transition. See [ROADMAP.md](ROADMAP.md) and [AGENTS.md](../AGENTS.md).

## Testing and environment

`tests/target-store-bootstrap.test.mjs` uses a temporary synthetic `AI_EXECUTIVE_DATA_DIR` and fresh sibling staging directories, checks preservation of a legacy sentinel (including symlink/`..` aliases), then tests SQLite foreign keys, scope separation, single effective Areas, shared workspace partition, assignee/member constraints, and `INSERT OR REPLACE`/`UPDATE OR REPLACE` bypass attempts.

The change uses a GitHub-only branch without a running app, local port, server data directory or preview deployment. Standard `PR Checks` must succeed on the PR's final head SHA. The full Browser E2E suite remains a pre-deployment release gate, not a PR gate.
