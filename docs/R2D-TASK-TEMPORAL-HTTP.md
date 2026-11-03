# R2d.3f — temporal task HTTP list (isolated staging)

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

This iteration covers the **list** endpoint only; a live-guarded individual
temporal detail and write/update commands belong to subsequent PRs. The full
Browser E2E suite is reserved for the pre-production deployment release gate.
