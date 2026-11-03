# R2d.3h.1 — staging-only idempotent task completion and reopening

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
