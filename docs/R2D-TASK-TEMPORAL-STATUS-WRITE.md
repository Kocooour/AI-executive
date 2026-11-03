# R2d.3h.1–2 — staging-only idempotent task completion and reopening

**Scope:** internal authenticated writer only; not HTTP, UI, production
database mutation or permission to activate staging writes. The isolated
v20 database remains in a private test directory.

## Command

Trusted writable `TargetStagingSessionAuthority.changeTemporalTaskStatus`
takes `sessionToken`, a strict six-field command and an optional live
durable-session token hash. The command fields are:

- `commandId`: a new UUID; exact retries reuse it;
- `taskId`: existing R2 write-compatible task ID;
- `status`: `completed` or `open`;
- `expectedRevision`: SHA-256 task+Area CAS returned by task-title preview;
- `writeAreaId`: named task Area, authorized inside the transaction;
- `restoreGeneration`: exact isolated staging restore generation.

No actor, completion timestamp, dueOn, project or sharing selector is
accepted. The writer chooses completedAtMs using its own server clock
and clears it atomically on reopen.

## Security, idempotency and audit

- A writable session is required. A durable staging session hash, if supplied,
  is checked for the current actor inside pinned BEGIN IMMEDIATE, both before
  the work and immediately before commit. No issuance or new route exists.
- Canonical preflight, generation, task/Area write ACL (owner or shared
  editor/admin), explicit Area match and optimistic CAS precede mutation.
  Shared viewers have no write grant. Unknown/nonwritable tasks are denied.
- Receipts are SHA-256 only, keyed by actor/task/command ID, in a separate
  capped `r2:task-temporal-status-receipt-v1:` metadata namespace. The digest
  includes exact status, revision, Area and restore generation. A replay
  rechecks current rights; conflicting UUID reuse cannot silently reapply.
- The same transaction updates the task, records the receipt and commits a
  content-free `temporal_status` intent to the append-only antirollback
  journal. SQLite triggers bump revisions, Area epochs and the change feed.
  The journal has a hashed receipt and numeric status, no title, user ID,
  token or timestamp. Any failure rolls the command back.
- Already-matching status is an unchanged/no-op response without receipt.
  Later changes require a fresh CAS token. Canonical preflight recognizes
  the new namespace, still rejecting malformed and unknown metadata.

## Subsequent steps

The next iteration adds a default-off HTTP adapter and command-status
reconciliation. A separate step will write the shared `dueOn` field; private
per-user today/when and the product UI are not enabled. Browser E2E remains
the preproduction release gate.

Focused test: `tests/target-task-temporal-status-writer.test.mjs`.

## R2d.3h.2 — explicitly opt-in HTTP command and reconciliation

The **four** independent default-off switches must all equal true:
`AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`,
`AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED`,
`AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED`, and the NEW
`AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED`. None of the
switches are enabled as part of this PR.

- `GET /api/target-staging/task-temporal/status?taskId=...` provides only
  `{expectedRevision,writeAreaId,restoreGeneration}` for a currently
  authorized writer, after a child read, title-CAS preview and live
  task/parent/Area guard recheck. No task content or credentials.
- `PATCH /api/target-staging/task-temporal/status` accepts exactly the six
  server-independent command fields above. Actor is always derived from the
  real owner cookie or durable staging-session cookie. CSRF Origin, protocol
  version 1, strict UTF-8 bounded JSON, per-route rate limits and preflight
  are mandatory. The writer rechecks durable-session, task ACL and CAS
  under BEGIN IMMEDIATE and writes an opaque receipt and journal intent.
- `POST /api/target-staging/task-temporal/status/receipt` accepts the SAME
  exact six-field command and returns `{status:"committed"|"not_recorded"}`
  without mutation. A canonical pinned snapshot must prove the CURRENT
  write right before reading the actor/task/command receipt; a separate
  temporal detail witness is rechecked against the live task/parent/Area
  before the response is released. Non-authorized, missing or moved tasks
  never reveal receipts. `not_recorded` is NOT permission to bypass CAS.
- Query-form task IDs preserve Unicode and padding, while the status writer
  intentionally inherits the prior non-empty R2 task write contract; HTTP
  rejects NUL, invalid UTF-16 and IDs over 4 KiB in subprocess transport.
- All responses are `no-store`. 401 means no valid identity, 404 means
  missing/foreign/inaccessible, 409 means CAS/idempotency conflict (or
  explicit resync/Area mismatch), 503 means staging unavailable.
  Child credentials never cross stdout; only strict response DTOs do.

No production cutover, due-date mutation, new persistent schema or user UI.
