# R2d.2c.2g.1 — note synchronization bootstrap manifest (staging-only)

This iteration adds the **internal, content-free Area manifest**
`readAuthorizedTargetNoteBootstrapPage`. It is a new, testable piece of
note synchronization, not an HTTP endpoint or an activated sync client.

## Contract

- The caller must supply a **verified server-side actor** and a preflighted,
  canonical, pinned, read-only staging SQLite snapshot (schema v16). Neither a
  route parameter nor an offline client is an identity authority.
- One Area per request. Private notes are visible only to their owner.
  Shared notes are visible to current viewers/editors/admins. **Standalone**
  notes (`notes.project_id IS NULL`) use their own `notes.area_id`. **Project-child**
  notes (`notes.project_id IS NOT NULL`) inherit the parent project's
  `projects.area_id` and must have `notes.area_id IS NULL`.
  Mentions/links confer no access.
- Pages contain at most 100 metadata entries: `id`, monotonic note
  `revision`, `projectId` and parent project `revision`. They contain no
  note title, body, actor receipts or tombstones. For contents use the
  separately authorized exact-note GET with a live-release guard.
- A SHA-256 snapshot revision binds the **entire** capped Area manifest,
  its access role, policy revision, actor, Area, and **canonical restore generation**
  read from the same pinned/preflighted SQLite snapshot. A missing or malformed
  UUID generation fails closed. This detects edits, ABA, parent revisions,
  membership/role changes, deletions, and store restoration between pages.
  After the first page, an internal `afterId` is accepted **only together**
  with the expected snapshot revision. A mismatch, including across a restored
  store with otherwise identical data, fails closed (null).
  ID order is SQLite binary UTF-8; the same order is used for keyset filtering.
- The 4096-note limit is enforced for **eligible notes in this Area** *before pagination*; the required canonical store preflight separately enforces the **global** staging cap. Any
  malformed eligible row, missing schema, excessive count or unauthorized
  Area fails closed with the same null result. The canonical store preflight
  remains a mandatory prerequisite and rejects structurally corrupt rows.
- Each result carries internal `linearization` metadata. A future HTTP
  adapter MUST recheck **live durable session**, identity, current Area ACL,
  policy revision, and per-note/parent guard **after** reading and before
  releasing each response. It also needs a signed opaque, identity-bound
  cursor and output DTO allowlist. Raw keyset IDs and raw internal witness
  must never become an external endpoint contract.

## Deliberate exclusions and next step

A full manifest may reconcile local IDs after a **fresh full bootstrap**;
omission in this manifest is **not a deletion event**. It is unsafe to treat
the append-only task/project change log as a note feed; content-free note
delete receipts are actor-bound and must not be enumerated by other actors.

Next: note-specific monotonic change journal and cursor with creation/edit/
deletion event boundaries, retroactive visibility/revocation and restore
handling, then a bounded child+HTTP read adapter and a dedicated offline
client. This must be separately reviewed and tested, including 2–3 actors
and mid-page revocation.

This PR does **not** modify schema, task/project feeds, production API,
client cache, IndexedDB, UI, deployment, credentials or persisted data.
All target staging flags remain default-off.

## R2d.2c.2g.2a — encrypted continuation cursor (staging-only)

`lib/target-note-sync-cursor.ts` provides a **standalone cursor primitive** for
future note bootstrap pagination and note-specific change journal consumption.
It does not enumerate changes, expose HTTP or grant any new read rights.

- A cursor carries **one Area**, a verified actor ID, session revocation epoch,
  restore generation, Area policy revision and current access role; the
  consumer compares every field with **server-derived** current values.
- Positions have two disjoint, strictly validated types: continuation after
  a bounded manifest entry with its whole-snapshot digest, or an exclusive
  monotonic `afterSeq` for a **future** note-only journal. No client-supplied
  first-page cursor or task/project change-log reuse.
- AES-256-GCM with fresh random 96-bit nonce, HKDF key separation from the
  existing task feed, authenticated domain and fixed-size padding keeps all
  metadata/positions confidential and limits structure leakage. Decode rejects
  noncanonical tokens, altered ciphertext, invalid bounds and extra claims.
- Tokens expire after seven days (up to 60s clock skew), and every failure
  has one uniform denied result. Role/policy changes, revoked session epochs
  and restore generation differences invalidate issued cursors.
- **Not an authorization decision**: API/child integration must separately
  validate current live durable session, actor, Area ACL, restore generation,
  note/parent guards and canonical pinned snapshot **before releasing data**.
  The caller must never seal an unchecked actor or client-selected position.
  A changed bootstrap digest forces full restart, not an inferred deletion.

Tests cover 2 actors and multiple role/Area/epoch/generation boundaries,
tampering and key separation, expiry, length privacy, bounds and roundtrips.
There is no schema migration, note journal writer, deletion visibility,
new API, client sync, UI, production change or deployment in this step.

**Next:** schema-guarded monotonic note-only journal integrated atomically
into note edits and deletes (and future create/move operations), with
visibility-history/retroactive permission rules, bounded retention and
rebootstrap-on-gap behavior; only then expose bounded HTTP pages with live
session/release guards and this encrypted cursor.

## R2d.2c.2g.2b.1 — audit-triggered note journal (staging only)

Schema v17 adds a dedicated, append-only note_change_journal table, with an
Area-local monotonic sequence (`(area_id, seq)`) and no global client-visible position. Audit INSERT triggers
append one content-free event for each authorized note edit or deletion
(kind, receipt key, actor, note ID, effective Area, historical parent,
Area policy revision, resulting note revision, timestamp). Audit and event
are in the SAME pinned SQLite transaction: a rollback leaves neither event
nor successful mutation. No note title/body or credentials are stored.

Canonical preflight verifies a bijection of events to edit/delete audits and
the matching fields. Events cannot be changed, deleted or replaced, and a
referenced note-edit audit cannot be deleted. At the provisional aggregate
8,192-event limit, mutations fail closed: there is no implicit compaction,
truncation or retention exception. Previously created isolated v16 staging
databases are rejected, not migrated. Production data is untouched.

The table is NOT exposed to clients. A current Area membership is not enough
to grant a newly added member access to historical note identifiers,
especially historical deletions. The next step must define retrospective
visibility, ACL changes, revocation, sequence-floor rebootstrap, retention,
and create/move behavior. Only then may bounded, live-checked note feed
reads use the encrypted cursor. No HTTP, UI, client sync, activation, release
or deployment is part of this iteration.
