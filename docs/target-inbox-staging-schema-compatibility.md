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

PR #485 must remain **Draft** until current-head CI and the independent
review pass; merging C-3a does **not** authorize deployment or the final
personal-v1 Inbox cutover. The binding milestone gates remain in
[issue #471](https://github.com/Kocooour/AI-executive/issues/471).
