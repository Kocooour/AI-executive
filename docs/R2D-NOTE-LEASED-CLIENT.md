# R2d — leased staging note metadata client integration (default-off)

This iteration connects the #201 global IndexedDB lease to the actual
`createStagingNotePersistentClient()` **browser default**. It is still
**not wired into Lumi's UI, production note API activation or deployment**.

## New data-safety contract

- Without a custom test storage adapter, `createStagingNotePersistentClient`
  creates `createStagingNoteLeasedClient` with a dedicated note-only IndexedDB
  database. No task sync database, queue, drafts, note body, title, credential,
  production server switch or data migration is touched.
- Only a single browser tab may hold the database writer lease. A second tab
  cannot activate while the first owns a live lease. `activate`, namespace
  opening, partition listing and deletion, reading the unverified checkpoint,
  checkpoint writes, resync checkpoint removal and signout purge all use
  `IndexedDbNoteMetadataLease` to verify owner/epoch/expiry **inside the same
  IndexedDB transaction** as their relevant operation.
- Active namespace handles are bound to their generation markers. A stale tab
  cannot recreate a deleted namespace or overwrite a successor's checkpoint.
  Neither a separate lease check followed by generic storage writes nor a
  generic task-sync namespace is allowed.
- The synchronously visible manifest is already gated on a new authorized
  server GET. The browser bridge additionally hides it on a cross-tab
  `BroadcastChannel` revocation or local lease expiry (29s conservative
  reader deadline for the 30s lease), and immediately clears on signout.
  Pull renews the lease before HTTP; a suspended or expired tab must explicitly
  reactivate after trusted authentication rather than publishing stale data.
- Signing out from a non-owner tab broadcasts invalidation to the actual writer;
  only the current owner may purge. BroadcastChannel is a **denial/invalidation
  hint**, not authentication or a replacement for live server authorization.
  Browser delivery is eventual, and an offline/disconnected device cannot be
  remotely erased. These limits must be accounted for at eventual UI activation.
- The explicitly injected `storage` option is preserved for isolated
  in-memory/IndexedDB unit fixtures. It is **not** a safe alternative for a
  production multi-tab client. Production callers must use the default guarded
  storage and trusted authenticated scope parameters.

## Validation / test boundaries

- Focused real Chromium tests in
  `e2e/note-leased-client-indexeddb.spec.ts`: competing two-tab activation,
  a non-owner signout revoking the current writer, partition purge before
  re-activation for a different actor, and a suspended response that cannot
  publish after another tab revokes access.
- Existing note client and lease tests still run to protect legacy synthetic
  adapter behavior and owner/epoch/namespace ABA invariants. The full
  `PR Checks` (typecheck, tests, build, HTTP smoke) and the **focused**
  `IndexedDB regression (Chromium)` workflow must pass on the exact PR head.
- Full Browser E2E is the **pre-production release gate only**. No
  implementation in this PR is permission to turn on note sync or to deploy.
  Authenticated UI session binding, recovery UX/freshness policy, production
  readiness and complete pre-release verification remain separate milestones.
