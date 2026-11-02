# R2d.2c.2g.2b.4a — isolated note metadata page reconciliation

This iteration introduces `lib/target-sync/note-pages.ts`, a **pure, unused
client-side state transition** over the expected R2d note-sync HTTP v1 DTO.
It does not create a network adapter, IndexedDB store, route consumer, UI
entry point, note content cache or production activation. The HTTP producer
is being developed separately in PR #195; this module is independently based
on `main` so both changes can be reviewed without mixing implementation
streams.

## Accepted data and behavior

- Exactly five response fields: `phase`, `entries`, `changes`, `more`,
  `cursor`. Only content-free note IDs, revisions and direct project
  parentage are retained. Unexpected fields, malformed UTF-8 identifiers,
  oversized pages and structurally invalid events are refused.
- First bootstrap page begins from `emptyNoteSyncPageState()`. Pages are
  staged and `readableNoteMetadata()` returns nothing until **the entire**
  Area manifest is received. Once complete, the working list becomes visible
  together with the next opaque change cursor.
- Change pages may advance the revision of a **known** note or delete a known
  note. They cannot introduce a note ID, move the effective parent, skip a
  revision or resurrect a deleted entry. Such changes return
  `resync_required`: restart with a new full Area bootstrap, not an
  inferred incremental reconciliation. This is intentional while there are
  no create/move events in the journal.
- Cursor progression occurs only in the returned new state. Invalid pages
  leave the old state untouched. An unfinished manifest never mixes with
  previously published metadata. The per-Area count cannot exceed 4096.
- This is not an authorization check. The server must still enforce live
  durable sessions, ACL, policy and restore-generation fencing. An opaque
  cursor is never an identity credential.

## Required before an online/offline consumer is attached

The future fetch/IndexedDB driver **must** partition note metadata by
authenticated user ID, restore generation **and** Area; it must not reuse
task/project sync storage keys, write queues, or the task feed. Network
responses must be checked against the active scope, and the cursor plus
manifest changes must be persisted atomically. Use independent versioned
namespaces with explicit deletion on logout, session revocation, Area 404
or generation mismatch, including in-flight response guards.

HTTP handling must also distinguish:

| HTTP result | Future driver behavior |
|---|---|
| 200 | Strictly decode then apply one page, atomically with its cursor |
| 401 or inaccessible Area 404 | Lock and discard the affected identity/Area cache; never continue |
| 409 `read_stale_reload` | Retry the **same** cursor; do not expose the stale page |
| 409 `resync_required` | Discard the incomplete/old Area manifest and bootstrap from cursorless start |
| 400, 429, 5xx, offline, malformed DTO | Do not advance state or expose pending pages; use bounded retry/backoff |

The pure transition does **not** implement these HTTP handling actions.
They are a separate integration and security review gate.

Unit tests cover multi-page bootstrap, zero-entry Areas, multiple edits,
deletions, duplicate/unknown IDs, revision and parent gaps, over-cap data,
malformed wire DTO, reset, and non-mutating refusal. Only staging synthetic
data is involved. No schema migration, deployment or full Browser E2E run.
