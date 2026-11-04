# R2d.3i.2 — default-off HTTP task dueOn set/clear and receipt

**Staging-only.** No production model activation, legacy DB writes, UI release,
product due-date scheduling automation, personal today/when, or schema change.

## Endpoint contract

- GET /api/target-staging/task-temporal/due-on?taskId=ID returns exactly
  dueOn (strict YYYY-MM-DD or null), expectedRevision (opaque SHA-256),
  writeAreaId, restoreGeneration. It never reveals the task title or members.
- PATCH /api/target-staging/task-temporal/due-on takes **exactly** commandId,
  taskId, dueOn, expectedRevision, writeAreaId, restoreGeneration.
  DueOn is a validated Gregorian date or null for clear. Successful replies
  are {ok:true} or {ok:true,replayed:true}; invalid input is 400, stale,
  unchanged or UUID conflict is 409.
- POST /api/target-staging/task-temporal/due-on/receipt takes the **same six
  fields**, is read-only, and reports {status:committed} or
  {status:not_recorded}. Exact actor+task+command+payload binding guarantees
  a mismatched UUID cannot be reconciled as success. This does not retry writes.

All responses use Cache-Control: no-store. The HTTP caller never supplies
identity, Area membership, title, completion timestamp or credentials as data.

## Activation / trust boundary

Four **independent explicit opt-ins** (all must be string true):
- AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED
- AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED
- AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED
- AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED

The status-write-specific flag
AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED is **not** required:
turning on dueOn writes must not silently turn on status complete/reopen.

All routes derive owner/durable-session identity on the server; require the
same staging anchor, auth and live session policy as R2d.3h.2; enforce
same-origin and protocol on mutation and receipt; reject over-sized or
malformed bodies; and enforce bounded rate limits. A request is processed by
short-lived, bounded child workers with a minimal environment and stdin JSON.
A child re-authenticates the same actor, checks current write permission for
the effective private/shared Area, restore generation, exact task+Area CAS
and (when applicable) durable session **inside** an isolated pinned SQLite
transaction before mutation or opaque receipt access.

GET and receipt first capture a canonical authenticated temporal detail, then
require write ACL, then call a second independently pinned writer/receipt
worker. Immediately before any response release, the server verifies the same
live task, inherited parent, Area policy and durable session guard;
authorization changes and snapshot races fail closed (404/401).
The server never returns full task content, receipt keys or audit data.

The R2d.3i.1 writer persists only the due_on date, not task status or
completed_at_ms; it records a separate opaque receipt and content-free
antirollback journal. If a mutation commits but its HTTP reply is lost, the
client must query the read-only receipt endpoint using the **same command**.

## Regression coverage

tests/target-staging-temporal-due-on-http.test.mjs covers all default-off
gates, independent status flag, authenticated preview, set/clear with no
completion change, receipt and replay, malformed date/command, CSRF/protocol,
stale CAS and UUID conflicts, current shared/private writer ACL, membership
revocation, durable session revocation, Unicode task identifiers, and
deterministic release races for task Area, inherited parent and
membership changes. The focused R2d workflow watches new helper, child and
test files. Browser end-to-end testing remains mandatory before production
deployment, not during every PR.
