# R2d.2c.2f — note tombstones and authenticated delete (isolated schema v16)

The v15 tombstone substrate was introduced by #185. R2d.2c.2f.2 adds a
**staging-only authenticated delete writer** and dedicated audit/receipt in v16.
This is not an HTTP endpoint, change feed, sync implementation, UI feature,
deployment or permission to reset any database. Target staging flags remain default-off. Legacy production
storage and credentials are unchanged.

## Invariants

- Notes retain stable IDs. A **permanent**, content-free `note_tombstones`
  entry reserves each deleted ID forever. The marker records the effective Area,
  the direct parent project ID (or NULL for a standalone note), the next note
  revision and a deletion timestamp. It must never contain the title or body.
- The marker can be prepared only for a **live** note with the exact canonical
  effective Area, parent and `revision + 1`. A direct note has its own Area;
  a project note inherits its current parent project Area. Typed links are not
  a parent or permission path.
- Plain `DELETE FROM notes` fails. A trusted, isolated staging transaction may
  prepare the exact tombstone and then delete the note. A later note update after
  tombstone preparation is rejected. The two statements **must** be committed or
  rolled back together; canonical preflight rejects a store in which the marker
  and a live note coexist. A raw SQL transaction is a schema-level test, **not**
  an authorized application write.
- A deleted ID cannot be reinserted, including through `INSERT OR REPLACE`.
  Tombstones cannot be updated, replaced or removed, and have a bounded capacity.
  This prevents reopening old note revision/ACL guards under a recycled ID.
- Historical note-edit audit rows are still retained after a note is removed:
  `note_edit_audit.note_id` intentionally has **no FK to the live notes table**.
  Audit rows are content-free and subject to the existing retention policy.
- Canonical preflight checks the new table, caps, valid metadata, area existence
  and absence of live/tombstone overlap even if SQLite CHECK/FK enforcement was
  bypassed. It fails closed on older schemas (including v14).

## R2d.2c.2f.2 — internal delete writer (schema v16)

- A signed staging **write-audience** session is required. Server authority
  verifies it, then a pinned `BEGIN IMMEDIATE` verifies current identity,
  Area editor/admin (private-owner), note/project revision, policy, expected
  write Area and restore generation again. If supplied, the durable HTTP session
  hash is checked both before and immediately before commit.
- One transaction inserts the matching immutable tombstone, deletes exactly one
  note revision, records an actor/note/UUID-specific opaque receipt and a
  content-free immutable `note_delete_audit` row. The shared writer wraps this
  in the irreversible `note_delete` intent/witness/confirm sequence. Failed
  validation and failed writes roll back all database mutations.
- An existing deletion may be replayed only by its original actor, with the
  exact request digest and **current** write permission in the tombstone's Area.
  Unknown IDs, other actors' tombstones and unpermitted Areas are indistinguishable.
- Canonical preflight validates both sides of the note-deletion ledger: every
  tombstone must have exactly one delete audit, and each audit must have its
  receipt and matching immutable tombstone (Area, parent, revision, timestamp).
  Corrupted, orphaned or raw SQL-only deletions fail closed.
- Restore from a backup taken **before any confirmed note deletion** is
  refused with `backup_predates_note_delete`: journal entries are deliberately
  content-free and cannot replay the erased ID. A backup taken after the last
  note deletion can be restored when only the existing replayable operations
  happened afterwards. This is fail-closed, not a full note restore protocol.
- All staging schema v15 stores are intentionally refused rather than migrated
  to v16. No existing production data is touched.

## Next activation gates

The writer is **internal only**. A later isolated HTTP DELETE/status must
enforce same-origin, exact command/session validation and live release checks,
including safe reconciliation of an uncertain response. Notes still have no
change-feed/cursor/sync semantics; their tombstones must not be interpreted as
task or project feed entries. No activation of notes UI or production migration.

Only recreate a disposable **test** staging store. Any future production cutover
requires separate owner approval of the exact scope, verified archival backup
and a restore rehearsal.
