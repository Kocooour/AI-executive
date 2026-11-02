# R2d.2c.2g.1 — note synchronization bootstrap manifest (staging-only)

This iteration adds the **internal, content-free Area manifest**
`readAuthorizedTargetNoteBootstrapPage`. It is a new, testable piece of
note synchronization, not an HTTP endpoint or an activated sync client.

## Contract

- The caller must supply a **verified server-side actor** and a preflighted,
  canonical, pinned, read-only staging SQLite snapshot (schema v16). Neither a
  route parameter nor an offline client is an identity authority.
- One Area per request. Private notes are visible only to their owner.
  Shared notes are visible to current viewers/editors/admins. A direct note
  inherits the *parent project's* Area. Mentions/links confer no access.
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
