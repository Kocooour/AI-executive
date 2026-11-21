# C-3a Inbox: staging-only v27 schema compatibility decision

**Review decision for PR #485 (2026-11-20).** C-3a remains a draft PR and its
v27 Inbox schema has not been merged by this PR or enabled as a production
cutover. The earlier *draft-only* v27 DDL limited
`task_triage_receipts` to **4,096** rows. Before review completion, the cap
was increased to **8,192** to reserve one durable future Undo receipt for
each live Process command. The schema version is intentionally still **27**.

## Compatibility policy for the unreleased draft

- **Current v27** means the complete canonical schema, including the 8,192-row
  receipt-capacity trigger and the writer-side live-Undo reservation. This is
  the only v27 shape accepted for new isolated C-3a staging fixtures.
- **Superseded draft v27** (4,096-row trigger) is **not** a deployed schema and
  is **not** eligible for transparent repair, downgrade, or auto-migration.
  Exact-DDL preflight rejects it with `schema_invalid`; the v26→v27
  upgrader refuses it without altering the SQLite file or the anchor journal.
- If an operator has **retained an old experimental staging directory**, it
  must be **preserved for inspection or backup**. After explicit review of its
  contents, the operator may provision a **separate new isolated test staging
  directory** using the current bootstrap, with fresh fixtures. Never reuse
  the same path or overwrite, delete, reset, or silently transform the older
  directory. No HTTP/startup path performs this action.
- **Actual existing target v26 data** remain covered by the explicit,
  pinned, atomic v26→v27 upgrade and its verified `processed` backfill.
  **Legacy/production data** are not touched by this staging decision.

The decision is intentionally limited to the **unreleased, isolated draft
test fixtures**. It is **not a general promise of backward compatibility for
future shipped v27 databases**. Before v27 is distributed or used for real
persistent data, the released schema must be frozen. Any subsequent on-disk
DDL change requires an explicit *new version and reviewed pinned migration*;
the draft-only exception must not be reused.

## Evidence and release gate

`tests/target-inbox-schema-upgrade.test.mjs` reconstructs the former
4,096-row trigger under schema version 27, checks exact-DDL preflight
rejection, and confirms the explicit upgrader leaves the database and
journal unchanged. The existing v26→v27 migration tests prove the separate
supported upgrade. `tests/target-inbox-triage-writer.test.mjs` protects
4,096 simultaneously active Process receipts and their reserved Undo capacity.

## Permanent cancellation capacity and safe rollover

C-3a's actor-bound **cancellation fences** are separate from the capped
`task_triage_receipts` history. A cancelled UUID may be delivered to the server
much later; no age, missing read-only receipt, or stale task CAS justifies
deleting its durable negative fence.

Earlier draft stores encoded fences as
`r3:inbox-triage-cancel-v1:<actorSha256>:<receiptSha256>` and allowed at most
4,096 entries per actor. Those original keys remain valid and **are never
deleted or rewritten**. New cancellations use the same prefix but append a
deterministic receipt-hash partition:
`<actorSha256>:<receiptHashPrefix>:<receiptSha256>`.
The prefix grows through **4, 8, 16, 32 and 64 hex digits** when the current
partition fills its 4,096-row quota. The terminal 64-digit partition is unique
to the original command, so no actor-lifetime 4,096-cancellation wall remains.
Every write and exact-command receipt lookup checks both the original format
and all five partition depths, even after restarts. The pinned write lock
serializes cancellation versus the original late Process/Undo, and canonical
preflight rejects forged shard prefixes, duplicate UUID fences across formats
and over-quota partitions. No SQLite table/trigger DDL or schema version changes
are required.

**Operator procedure (capacity / free disk):** Monitor the isolated staging
SQLite file size, metadata-row counts and available filesystem capacity. This
ledger is durable and its storage and canonical preflight cost grow with the
number of actual cancellations; it is not an unlimited-memory cache. The HTTP
cancel route is authenticated, default-OFF and rate limited, but disk-space
exhaustion can still cause a safe 503. On low capacity, disable new Inbox
writes, stop writers, preserve the *whole* staging database, journal, witness
and access controls, expand the existing secure volume without resetting its
files or restore generation, perform the normal read-only integrity preflight,
then re-enable writes only after review. Retry only the **same UUID** and
verify its exact receipt. If filesystem expansion and healthy preflight are
not possible, leave writes disabled and escalate to an independently reviewed
generation-rotation/data-migration plan; never hand-edit, delete, expire or
truncate active cancellation fences, reuse a previous restore generation,
restore a pre-cancellation backup, or silently issue a new UUID.

The regression in `tests/target-inbox-http.test.mjs` seeds 4,096 valid
old-format fences and verifies safe acceptance of another cancellation with
old entries untouched. It separately fills a first-level 4-digit partition,
proves an 8-digit fallback, preserves the old cancelled command's refusal and
checks canonical staging preflight. This is isolated staging verification, not
authorization to cut over a persistent production store.

PR #485 must remain **Draft** until current-head CI and the independent
review pass; merging C-3a does **not** authorize deployment or the final
personal-v1 Inbox cutover. The binding milestone gates remain in
[issue #471](https://github.com/Kocooour/AI-executive/issues/471).
