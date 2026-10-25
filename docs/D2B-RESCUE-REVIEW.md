# D2b part 5 — read-only review of a saved rescue file

Scope: The owner can select a local D2b v1 JSON rescue file **while the
restore hold remains active**. This adds a diagnostic step, not release.

- The file is read with the browser File API after rejecting zero-byte and
  over-12-MiB files. Bytes remain in volatile browser memory only.
- A read-only GET of the current server snapshot is mandatory. Offline,
  unauthenticated, malformed or older-generation server evidence fails closed;
  unlike the export, a comparative inspection is never labelled verified
  without a current server response.
- The existing bounded UTF-8/schema/SHA validator compares with that snapshot.
  The owner sees only aggregate counts of changed entities, relations, drafts,
  pending intents and classification reasons, with **no titles, IDs or draft
  bodies** in the UI, URL, storage, server requests or logs.
- The assessment is provisional: server state can change after GET, the hash
  checks integrity rather than authenticity, and neither file inspection nor
  a "no-local-changes" result establishes current Area permissions, workspace
  membership, owner consent, successful download or permission to replay.
- The hold remains active. No import, mutation, discard, reconcile, automatic
  merge, unfreeze or cross-tab release is implemented here. Separate audited
  membership/ownership review and a crash-safe owner decision are still needed.

Validation: unit tests in `tests/d2b-recovery-review.test.mjs` cover private
data redaction, counts, corrupted files, generation rejection and the no-change
case. PR Checks must run typecheck, tests and build on the exact PR head.
Focused multi-tab/browser recovery tests and independent security review are
required before this UI can be considered merge-ready. Full browser E2E is
reserved for the exact-SHA pre-deployment gate.
