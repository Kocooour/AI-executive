# R1 → R2 foundation — target Area policy (staging only)

`lib/target-area-policy.ts` contains two explicit, read-only helpers over a
caller-supplied `DatabaseSync` for the **isolated target schema**:

- `evaluateTargetAreaPolicy(db, { actorUserId, areaId, permission })` evaluates
  one concrete Area for `read`, ordinary `write`, or `admin`.
- `resolveTargetCreateArea(db, { kind, actorUserId, writeAreaId, ... })` checks
  creation of a project, standalone task, or project task. Every create request
  requires one explicit `writeAreaId`; a project task also requires `projectId`
  and the selected Area must match the project's inherited Area. `my-plan` and
  `all` are aggregate scopes, never Area IDs or write destinations.

The caller-provided `actorUserId` is **synthetic**. No authenticated session,
token, device or integration identity is bound here. These helpers must not be
used as the server's ACL until R2 implements identity binding, policy/revision
checks and per-item command/sync boundaries. They are not wired to app startup,
runtime routes, UI, AI tools, old snapshots, sync or the production database.

The private Area owner may read, write and administer it; no other identity
may access it. In shared Areas, an explicit current viewer/editor/admin member
may read; editor/admin may ordinarily write; only admin may manage Area policy.
An unknown actor, nonexistent/inaccessible Area, missing membership, or
inaccessible project fails closed. A viewer cannot create ordinary content.
The optional task `assigneeUserId` follows the present R1 schema: private
tasks have no explicit assignee; a shared task may select only an editor/admin
member. This helper does not perform an insertion or authoritatively validate
an entire command payload.

Results contain only `{ allowed, reason, effectiveAreaId }`. Denials always
have `effectiveAreaId: null` and contain no task/project title, member list,
private Area ID or raw database error. Inaccessible Areas and projects use
generic unavailable reasons. A mismatched project Area is distinguished only
after the actor can write the selected Area and read the project's Area.
Neither a read aggregation nor a current UI filter grants write rights. A
shared Area must be explicitly named; this resolver never defaults a private
creation into shared space or silently moves/publishes an existing project.

These checks are a small policy building block, **not** R2 readiness: the
caller must still ensure an isolated, validated and stable staging database;
authenticate the actor; use a transaction with current policy and entity
revisions; validate complete command fields; enforce recipient/content
approval and audit for visibility changes; reject legacy full-snapshot writes
before mutation; and implement per-user read models, revocation, cache/sync
barriers and recovery. No production reset, cutover, feature activation or
deployment is authorized by this iteration. See [PRODUCT.md](PRODUCT.md)
LUMI-FR-013, [ARCHITECTURE.md](ARCHITECTURE.md) target Areas and
[ROADMAP.md](ROADMAP.md) R1–R4.

`tests/target-area-policy.test.mjs` creates only synthetic isolated staging
data for three identities and checks private/shared permissions, viewer and
nonmember denies, project inheritance/mismatch, explicit Area selection,
assignee boundaries, no implicit publication and unchanged staging/legacy
bytes. The helper itself executes no mutation.
