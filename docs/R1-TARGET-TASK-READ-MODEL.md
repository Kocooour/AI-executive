# R1 -> R2: isolated per-actor task read scopes (staging only)

This is a **read-only, staging-only** follow-up to PR #129. The module
`lib/target-task-read-model.ts` reads the explicitly bootstrapped isolated
target schema. It is not imported by live server routes, sync, UI, AI,
notifications, integrations, startup or production storage.

## Selector contract

- `listIsolatedTargetTasks(db, { actorUserId, scope, limit?, afterTaskId? })`
  supports exactly `my-plan`, `personal`, `shared`. These are read filters,
  never write destinations.
- `readIsolatedTargetTask(db, { actorUserId, taskId })` allows a direct detail
  read only under the same Area-based authorization as the list. It does not
  restrict a permitted shared project detail to the user's `my-plan` filter.
- `personal` selects tasks belonging to the actor's private Areas.
  `shared` selects tasks in shared Areas with a current viewer/editor/admin
  membership, including other members' and unassigned tasks.
  `my-plan` selects private tasks plus shared tasks assigned to the actor
  who currently has editor/admin membership. Creating a shared task does
  not automatically put it in the creator's plan.
- Project children obtain their effective Area only from their parent project;
  independent tasks use their own concrete Area. Malformed task-to-project
  relationships are not used as a fallback permission path.
- Both queries check the owner/workspace boundary and current Area membership
  **inside the SELECT**. They never trust a caller-provided Area, workspace,
  task owner, read scope, or client-side filter as authority.
- A direct lookup that is missing or forbidden has the same `unavailable`
  result. Missing actor IDs yield an empty list, as does zero authorized work.
  Database failures return a bounded `query_failed` reason; no raw SQLite
  error, inaccessible title, or member list is returned.
- Lists are bounded to 1–100 records (default 50), ordered by canonical ID
  and optionally traversed using `afterTaskId`. The cursor is for isolated
  staging tests **only**; it is not a revision-consistent or authenticated
  synchronization cursor.

## Explicit limitations and activation barriers

`actorUserId` here is caller-selected, **synthetic and unauthenticated**.
These selectors operate only on a separately validated stable staging
database. They do not implement user login/session binding, current revision
tokens, snapshot-consistent paging, complete task lifecycle/active state,
per-user calendar/attention state, policy/admin/revocation transactions,
audit, cross-Area provenance, R2 sync invalidation, API authorizations,
AI/search/export protections, or a cutover. The minimal R1 target tasks table
does not yet contain an active/completed status or revisions; consequently
this iteration does **not** implement the full Projects-in-My-Plan criterion,
active-only project selection, or any UI activation.

Before a real application can consume this model, R2 must bind each request
to the authenticated actor; verify the complete R2 preflight including a
valid shared mapping and active admin; enforce the same predicates for every
endpoint and derived index; add transactional policy/entity revision checks,
revocation/cache clearing and an authenticated versioned sync protocol;
and ensure no legacy full-snapshot write can modify the target generation.
Nothing here authorizes an existing-data reset, migration, release or
production deployment.

Synthetic tests in `tests/target-task-read-model.test.mjs` exercise four
identities, private/shared/assigned/unassigned/project-child cases, a
viewer and a non-member, direct unauthorized reads, pagination, invalid
inputs and database errors, post-revocation access denial, and unchanged
staging/legacy file content during reads. The full browser E2E suite remains
a **release gate**, not a per-PR action.

See [PRODUCT.md](PRODUCT.md) LUMI-FR-013, [UX-UI.md](UX-UI.md) target scopes,
[ARCHITECTURE.md](ARCHITECTURE.md) authorization boundaries, and
[ROADMAP.md](ROADMAP.md) milestones R1–R4.
