# R2d.3f–g — temporal task HTTP reads (isolated staging)

Read-only **GET /api/target-staging/task-temporal**. The endpoint is absent
(404) unless **both** `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` and
`AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED=true` are configured.
No default activation, no production cutover, no legacy storage access or UI.

## Contract

- Query: optional `scope=personal|shared|my-plan` (default personal),
  `status=all|open|completed` (default all), `limit=1..100` (default 50),
  `cursor` (HMAC bound to current actor/session, store generation, scope,
  status and content revision). Duplicate/unknown params and raw offset are
  rejected. Expired/stale cursors are content-free 409 responses.
- DTO: `{ tasks: [{id,title,projectId,areaId,areaKind,status,
  completedAtMs,dueOn,assignedToMe?}], hasMore, nextCursor }`.
  `assignedToMe` only on shared rows; no member list, other assignee ID,
  Area linearization or personal today/when.
- Strict parser reconstructs an explicit DTO allowlist at the child-process
  boundary and checks scope/status, integer timestamp, ISO date, ordered task
  identifiers, role/Area witness and page limits. Task IDs retain the
  canonical v20 SQLite TEXT contract (including long, padded, Unicode IDs).
- Principal comes only from a configured owner cookie or a verified durable
  staging session. The bounded isolated child performs pinned canonical
  preflight and SQLite read; the HTTP process re-checks live session, current
  Area memberships, access roles and policy revisions before returning data.
  A changed Area witness produces `read_stale_reload`, not leaked content.
- Separate HTTP rate limiting, `no-store`, environment binding recheck and
  fail-closed child failure handling. Nothing writes the staging/legacy store.

## Tests and limitations

`tests/target-staging-temporal-http.test.mjs`: flag/auth/query refusals,
private/shared/my-plan + viewer, status filtering, strict DTO allowlist,
cross-user cursor rejection, stale revision after changes, and live Area
revocation after the child snapshot. CI runs focused R2d tests and PR Checks.

## R2d.3g — individual temporal task detail

- **GET /api/target-staging/task-temporal/detail?taskId=<encoded-id>** shares both
  default-off gates, canonical pinned child preflight, durable session/owner
  authentication and independent HTTP rate limiting. No actor/Area selector.
- `taskId` is the only allowed query key and must appear exactly once. This
  query form preserves empty, padded, Unicode and long SQLite TEXT IDs which
  cannot safely be expressed as path segments. Subprocess transport limits
  this particular endpoint to <=4096 UTF-8 bytes and rejects NUL (the list
  endpoint remains backward-compatible). No implicit trim.
- Positive response: `{task:{id,title,projectId,areaId,areaKind,status,
  completedAtMs,dueOn,assignedToMe?}}`. Absent/inaccessible and stale records
  produce the same content-free 404; invalid query gives 400; failed child or
  invalid config gives 503; dead durable sessions give 401. Always no-store.
- The child emits an INTERNAL revision guard (task ID, effective Area,
  project ID, task revision and parent project revision) from the SAME pinned
  snapshot as the detail. A strict boundary parser validates all fields.
- One live read transaction checks the actor/session and Area policy plus
  exact row identity, effective Area, task revision and project revision
  immediately before the body is returned. Assignment, reparenting, moves,
  completion, due-date or title ABA all invalidate the result. Only the task
  DTO is released; the guard and Area witness are never exposed.
- `tests/target-staging-temporal-http.test.mjs` includes owner/viewer and
  foreign/unknown denial, legacy ID compatibility, task edit/move, parent
  changes, membership/session revocation and malicious child DTO checks.

Neither endpoint implements writes, Today/Upcoming UI or production cutover.
The full Browser E2E suite remains reserved for the pre-production release gate.
