# R2d.2c.2f.1 — note tombstones in isolated staging (schema v15)

This is a **schema boundary only**, not an authenticated deletion command, HTTP
endpoint, change feed, sync implementation, UI feature, deployment or permission
to reset any database. Target staging flags remain default-off. Legacy production
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

## Next activation gates

A real note deletion command is **not yet implemented**. Before it can be used,
the same signed write-audience actor, durable-session check, current Area/editor
authorization, exact note+project+policy revision and restore generation must be
revalidated under one pinned `BEGIN IMMEDIATE` transaction. Tombstone insertion,
deletion, actor/command-UUID receipt, content-free delete audit and the irreversible
journal/witness commit must be atomic. Denied requests and retries must not leak
the deleted note or other actors' receipts; uncertain responses need a bounded
status endpoint. Note tombstones are **not in the current task/project change
feed**, and no client may interpret this schema as a working note sync protocol.
The deletion writer and note-specific feed/cursor semantics need separate tests
and code review before any HTTP or UI activation.

There is no migration or backfill from v14 here. Only recreate an **isolated,
disposable test** staging store. A future production cutover/reset needs explicit
owner approval, an archival backup and a verified restore plan.
