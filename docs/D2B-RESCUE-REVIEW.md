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
  Before showing counts, the inspected v1 bundle must match the active browser
  recovery hold: its old generation equals the hold's known generation (or 0
  for an unknown one), its observed generation is not older than the first
  observed mismatch, and its creation time is not earlier than the hold.
  Multi-restore exports are allowed when these conditions and the current
  server generation checks all pass. A v1 file has no signed hold ID, so
  matching metadata only establishes consistency, **not identity, authorship,
  authenticity, current Area membership or authorization**.
- The owner sees only aggregate counts of changed entities, relations, drafts,
  pending intents and all seven classification reasons (including already
  present/deleted and local-only), with **no titles, IDs or draft bodies** in
  the UI, URL, storage, server requests or logs. All reason counts add up to
  the number of classified entity/relation changes; pending markers and
  drafts are separate, non-classified counts.
- New file selections or cancellations immediately clear the previous summary
  and busy state. The native file input's `cancel` event is handled explicitly:
  it clears the previous diagnosis without bubbling into the outer non-dismissible
  recovery dialog's `cancel` handler. A late file read or server response
  cannot publish stale results or re-disable the picker.
- The assessment is provisional: server state can change after GET, the hash
  checks integrity rather than authenticity, and neither file inspection nor
  a "no-local-changes" result establishes current Area permissions, workspace
  membership, owner consent, successful download or permission to replay.
- The hold remains active. No import, mutation, discard, reconcile, automatic
  merge, unfreeze or cross-tab release is implemented here. Separate audited
  membership/ownership review and a crash-safe owner decision are still needed.

Validation: unit tests in `tests/d2b-recovery-review.test.mjs` cover private
data redaction, exhaustive classifications, hold mismatches, later restores,
corrupted files, generation rejection and the no-change case.
`tests/d2b-recovery-review-request.test.mjs` covers cancelled and overlapping
file reads, late results, stale/active errors, and cancellation following a
completed diagnosis. `e2e/app.spec.ts` includes a **focused** Playwright scenario
for the actual input `cancel` event, old-error clearing, and the still-open safety
dialog; run it with `pnpm test:e2e -g "native recovery file-picker cancel"`
using isolated synthetic data. PR Checks must run typecheck, tests and build on
the exact PR head.
Focused multi-tab/browser recovery tests and independent security review are
required before this UI can be considered merge-ready. Full browser E2E is
reserved for the exact-SHA pre-deployment gate.
