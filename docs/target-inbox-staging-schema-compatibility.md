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

## C-3a cancellation: bounded monotonic CAS retirement

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
   stores ONE `r3:inbox-tombstone-cancel-v1:<sha256>` marker containing only
   the actor and task IDs. Its key is derived from both; further requests
   with arbitrarily many UUIDs re-use that exact marker. Subsequent receipt
   reads may acknowledge this actor's reconciliation without revealing a
   tombstone before the explicit request. Canonical preflight verifies the
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
nonexistent tasks cannot write; four unrelated UUIDs aimed at one unchanged
original snapshot produce only one monotonic revision advance; existing
4,096-row legacy and draft-shard ledgers remain unchanged and do not block
safe recovery; receipt/Process races and tombstone ACL still hold.
`e2e/target-inbox-acceptance.spec.ts` exercises a lost POST followed by
a concurrent title edit, and confirms zero new permanent UUID fences.

PR #485 must remain **Draft** until current-head CI and the independent
review pass; merging C-3a does **not** authorize deployment or the final
personal-v1 Inbox cutover. The binding milestone gates remain in
[issue #471](https://github.com/Kocooour/AI-executive/issues/471).
