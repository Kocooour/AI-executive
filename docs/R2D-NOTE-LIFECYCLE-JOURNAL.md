# R2d — Note lifecycle journal (staging schema v19)

This iteration extends the default-off, **isolated staging** note feed to cover
authenticated note creation and movement, not just edits/deletions. It is NOT a
production cutover or a UI feature.

## Event and authorization contract

- Schema v19 is mandatory. Prior v18 test/staging stores are **not migrated**;
  canonical preflight rejects them. Do not recreate any real data without
  separate owner approval and a verified backup.
- A newly authorized `create` inserts a content-free lifecycle receipt and
  immutable audit in the same pinned `BEGIN IMMEDIATE` transaction as the
  note row. The audit trigger appends **one destination `upsert` event**.
- Moving a note within the same Area (including changing its parent project)
  appends **one `upsert`** carrying the new project ID, parent revision and
  monotonically advanced note revision. Moving across Areas appends **one
  `leave` event in the source Area and one `upsert` in the destination
  Area**. The source event reveals no destination, and the destination event
  reveals no source. The audit records BOTH Area policy revisions under the
  pinned write lock: `leave` witnesses the source policy and `upsert` the
  destination policy. Canonical preflight checks both historical revisions
  and the immutable journal's exact audit correspondence. The old Area and
  new Area each advance their separate witness by exactly one. Same-Area
  moves advance once.
- The trusted writer rechecks the signed write-audience credential, current
  store generation, both source/destination write ACLs, the exact source CAS
  and optional live durable session under the pinned write lock. Moving a
  note from ANY other Area into a shared Area needs `confirmShare: true`
  (including shared-to-shared, where the audience may expand). Same-Area
  reparenting does not need additional sharing confirmation. Receipt keys
  are actor/note/command-bound SHA-256 and store only a digest, not title/body.
- Canonical preflight strictly validates receipts, lifecycle audits, historical
  revisions and both forward/reverse journal provenance. The append-only tables
  reject tampering and INSERT OR REPLACE. Capacity exhaustion rolls back the
  entire transaction. Raw unjournaled INSERT or UPDATE still increments the
  witness but does not invent a signed event: clients must rebootstrap.
- Existing note HTTP flags remain **default OFF**. Only the existing authorized,
  no-store note-sync GET may carry the new content-free event DTO fields. The
  cursor remains encrypted, scope/session/role/generation bound, with live
  authorization and current Area witness checked before release. Current
  verified clients reconcile `upsert` and `leave` without copying note
  bodies or foreign Area metadata into IndexedDB.
- There is no create/move HTTP mutation route, offline note edit queue,
  background polling, active UI hook, schema migration, deployment or
  production data change. The internal authority method can be exercised with
  synthetic isolated staging credentials and databases only.

## Checks and remaining release gates

- `tests/target-note-lifecycle-journal.test.mjs` covers live staging
  writer, private-to-shared confirmation, inherited project membership,
  journal/witness density, Area-local reconciliation and raw gaps.
- Existing note sync bootstrap, HTTP, IndexedDB, staging preflight and
  schema tests must remain green. PR Checks (typecheck/unit/build) and
  focused Chromium gate are mandatory on the exact PR head.
- Full Browser E2E remains a production deployment gate, not a per-PR test.
  Activation additionally requires a reviewed UI/session flow, explicit
  cross-tab writer isolation and a separate production release decision.
