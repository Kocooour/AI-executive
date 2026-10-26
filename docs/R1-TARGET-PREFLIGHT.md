# R1 (part 2) — read-only target staging preflight

`inspectIsolatedTargetStore({ stagingDirectory, expectedOwnerUserId?, expectedRestoreGeneration?, mode? })`
in `lib/target-store-preflight.ts` is explicitly invoked, not connected to app
startup, routes, UI, sync or integrations. It inspects an **existing** isolated
target staging directory. The path must be absolute, present, and disjoint from
`AI_EXECUTIVE_DATA_DIR` after symlink-aware canonicalization. The SQLite file must
exist as a regular file, not a symlink. SQLite is opened read-only; the helper
rejects WAL-mode files and existing `-wal`/`-shm` sidecars before opening SQLite,
because even a read-only SQLite open can create sidecar files. The helper does not
create directories, databases or sidecar files. Its typed
`{ ok, mode, issues }` diagnostics contain no task content, IDs, paths or raw
SQLite errors. `ok: false` fails closed.

The caller must ensure the staging directory is exclusively controlled and not
modified by another process throughout inspection. Header, sidecar and symlink
checks precede the SQLite open but do not constitute an atomic filesystem
snapshot against a concurrent path-replacement attacker.

Default `mode: "stage"` verifies exact inactive metadata, optional expected owner
and restore generation, canonical SQL definitions of tables/views/indexes/triggers, SQLite
quick/integrity and foreign-key checks, personal workspace and private
`Nezařazeno` boundaries, task effective Areas and shared task assignees. An
incomplete shared workspace can be a valid R1 staging intermediate state.

Optional `mode: "r2-model"` additionally checks complete shared workspace/Area
1:1 mapping and an admin member for every shared Area. This is only a stricter
**data-model inspection**, not evidence that active R2 server authorization is
implemented. Neither mode verifies actor identity or session handling,
Area-scoped ACL for reads/writes, sync/restore-generation barriers for old clients,
cache revocation, integrations or every application write path. Even `ok: true`
does **not** authorize activation, production cutover, reset, migration, deletion
or deployment. R2–R4 gates, verified archival backup/restore and separate explicit
owner approval remain mandatory; see [ROADMAP.md](ROADMAP.md),
[R1-TARGET-BOOTSTRAP.md](R1-TARGET-BOOTSTRAP.md) and [AGENTS.md](../AGENTS.md).

`tests/target-store-preflight.test.mjs` uses synthetic stores and checks valid
inactive bootstrap, metadata/schema/FK/assignee tampering, missing or corrupt
database, path aliases, WAL-mode and sidecar states, and unchanged database bytes,
directory inventory and legacy sentinel.
This GitHub-only helper needs no app instance, local port, preview or production
state. PR Checks (typecheck, unit tests, build) and review are still required;
the full browser E2E suite is a release gate immediately before deployment only.
