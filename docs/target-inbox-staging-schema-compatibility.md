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

## C-3a cancellation: issued command identity and bounded retirement

The Inbox read endpoint issues an actor-specific, signed `expectedRevision`
**only** for rows the actor can currently edit. This 64-hex CAS contains a
128-bit fingerprint of the canonical task revision plus a 128-bit HMAC,
bound to actor, task, Area, triage epoch and restore generation. The underlying
HMAC key is domain-separated from `AI_EXECUTIVE_SESSION_SECRET`; only the
Inbox-specific derived key enters isolated read/write workers. The signing
secret itself is never sent to a child or to the browser.

The client derives a UUIDv5-shaped command ID from the *entire* original
Process/Undo payload, including its issued CAS and any Undo parent ID. The
server independently checks BOTH the actor-issued HMAC and exact UUID binding
under the pinned write lock. Consequently a retired UUID cannot be used with
a new CAS, Area, actor, mode or Undo parent—even though new cancellations do
not create unlimited UUID tombstones. No actor other than the original issuer
can obtain `cancelled` for that original command from a stale read witness.
An older draft committed receipt or exact permanent cancellation fence is
still acknowledged by its existing actor-bound receipt/digest before the new
issuance check; new unsigned commands are not accepted.

**Deployment:** signed Inbox witnesses are specific to the currently
configured application session secret and restore generation. Rotate either
only with explicit migration and pending-command reconciliation. Older
in-flight *uncommitted* unsigned draft commands cannot be silently treated
as signed; keep the C-3a HTTP flags disabled until outstanding draft clients
are drained or the isolated stage has been explicitly and safely rotated.

An ambiguous Process/Undo POST is serialized under the pinned staging write
lock against the cancellation operation. A task can never return to an older
task revision, Area policy revision or restore generation, and a tombstoned task
ID can never be reused. These are the durable anti-ABA guarantees that prevent
any late original command from passing the *same* CAS again.

1. **Live task, matching original CAS:** The cancellation writer validates
   current actor/task write ACL, the named Area, session and generation, then
   atomically advances only `tasks.revision` by one. Existing canonical triggers
   advance the Area content epoch and bounded change log. This makes the
   original command's CAS irrevocably stale while allowing a newly authorized
   Process with a new CAS. An uncertain COMMIT is reconciled by a fresh
   read-only CAS check; no permanent per-command cancellation row is needed.
2. **Live task, already-stale CAS:** If no exact actor+UUID committed receipt
   exists, a pinned read safely returns `cancelled` because the original
   Process/Undo can *never commit in the future*. Unlike a mere
   `not_recorded` receipt, this is durable monotonic proof; there is no
   write or metadata growth. The committed receipt always takes precedence.
3. **Immutable deleted task:** Only an actor still allowed to write its
   tombstone may explicitly request cancellation. The first such request
   stores ONE `r3:inbox-tombstone-cancel-v1:<sha256>` marker with an
   opaque pair of actor/task SHA-256 digests (never plaintext IDs). Its key is
   derived from both. Only a server-issued, actor-signed original command
   with current ACL to its original Area may create this marker; guessed
   tombstone IDs and fabricated UUIDs fail closed. Repeated cancellation of
   the same issued command reuses the existing marker. Subsequent receipt
   reads can acknowledge this actor's issued command without exposing any
   deleted task to another editor. Canonical preflight verifies the
   registered identity, matching immutable task tombstone, key derivation and
   the per-actor bound of at most **4,096 markers** (the tombstone table's
   own hard bound). No task, no marker.
4. **Never-existing or unauthorized task:** Reject without a write. A claimed
   writable Area alone cannot authorize cancellation, and arbitrary UUIDs
   never allocate durable storage.

**Compatibility:** Existing old-format
`r3:inbox-triage-cancel-v1:<actorSha256>:<receiptSha256>` and draft nested
receipt-hash fences remain readable, immutable and checked *before* every
Process/Undo. Canonical preflight retains strict shape, digest and per-shard
capacity validation. No existing fence is deleted, expired or silently
converted; no table/trigger DDL change or schema-version change is needed.
New cancellations create no additional actor+UUID fences. The one-per-tombstone
marker is an additive, content-free metadata namespace in this still-unreleased
v27 draft.

**Cancelled Undo replacement:** If a pending *Undo* is explicitly cancelled
before it commits, its original CAS is retired by the monotonic task revision,
but the original Process receipt remains usable for a fresh, separately
self-bound Undo **only when the intervening task revisions were caused solely
by those Undo cancellations**. A single canonical
`r3:inbox-undo-rebase-v1:<actor-scoped Process receipt SHA-256>` metadata
record tracks the latest such revision; it contains only that revision number,
never a name, actor or task ID. Repeated Undo cancellations update the same
record. The record is checked with the exact Process receipt, actor, task,
triage epoch, restore generation, current edit ACL and current CAS, plus the
absence of a committed Undo child. A newer ordinary edit moves the task
revision beyond the witness and **permanently disables that Process's Undo**;
a prior cancelled Undo UUID can never be rebound to a new CAS.

The receipt endpoint returns an authorized replacement Undo witness for a
cancelled Undo while that lineage is still current. Browser UI makes the
replacement available immediately and preserves the original cancelled command
in tab-scoped recovery storage across reload, revalidating its receipt rather
than automatically reissuing the old UUID. A missing/failed receipt leaves
the recovery uncertain. Process cancellation behavior is unchanged.

Canonical preflight validates each marker's retained Process receipt,
strict revision bounds, live task or tombstone monotonicity and any committed
Undo child. The metadata count is at most the 8,192 retained Process/Undo
receipts; normal 90-day receipt maintenance cleans markers only after their
Process receipt is safely pruned. Receipt capacity reserves future Undo even
after cancellation-only revision advances. The draft v27 SQLite
`task_triage_receipts_guarded_delete` trigger also protects active rebased
Process receipts after the 90-day minimum; `task_triage_receipts_rebase_cleanup`
atomically deletes a Process's opaque rebase marker when that expired, now
ineligible receipt is actually deleted (including direct operator SQL).
This changes only the not-yet-shipped v27 trigger DDL, not the schema version,
receipt protocol or production migration. No extra table, raw session secret
in workers, permanent per-Undo fences or task-content persistence is introduced.
A forged marker, dangling parent, inconsistent historical Undo revision, or
unexpected metadata remains fail-closed.

**Operational gates:** Monitor the isolated staging SQLite, canonical
preflight and ordinary bounded `change_log` capacity. A 503 or an untrusted
journal is NOT authority to retry under a new UUID; recover using the exact
command receipt and verified current CAS. On physical volume exhaustion,
stop writes, preserve the SQLite, journal, witness and restore generation,
expand the existing secure filesystem capacity, run preflight and re-enable
only after operator review. Never manually delete old UUID fences, remove
tombstones, reset task revisions or restore an old database under the
unchanged generation.

Regression coverage: `tests/target-inbox-http.test.mjs` verifies forged
nonexistent tasks and fabricated command IDs cannot write; a *valid signed*
cancellation advances the original task CAS just once; a retired UUID cannot
be rebound to a fresh issued CAS; existing 4,096-row legacy and draft-shard
ledgers remain unchanged and do not block safe recovery. Cross-actor Area
moves cannot reveal another user's uncommitted receipt; tombstone markers
never contain plaintext actor/task IDs; receipt/Process races and ACL hold.
`e2e/target-inbox-acceptance.spec.ts` exercises a lost POST followed by
a concurrent title edit, and confirms zero new permanent UUID fences.

PR #485 must remain **Draft** until current-head CI and the independent
review pass; merging C-3a does **not** authorize deployment or the final
personal-v1 Inbox cutover. The binding milestone gates remain in
[issue #471](https://github.com/Kocooour/AI-executive/issues/471).
