# R2d.2c.2g.2b.4d — isolated IndexedDB checkpoint for note metadata

This iteration adds default-unused note metadata persistence. The HTTP
producer (#195), pure reconciler (#196), volatile transport (#197) and
combined real-HTTP integration tests (#198) are already in main.

## Scope and safety

- The new persistent client uses a separate browser IndexedDB database
  (lumi-note-metadata-v1) via the existing transactional storage adapter;
  no task/project namespaces, command queues, drafts or UI are reused.
- One namespace per trusted authenticated userId, canonical
  restoreGeneration, and exact Area ID (encoded so pipes, Unicode and percent
  signs cannot collide). Version 1 contains ONE atomic record with the manifest,
  incomplete bootstrap and opaque cursor, strict allowlists and a 4096-note cap.
  No note titles, bodies, credentials, journal sequence or audit contents.
- activate(scope) must only receive identity and generation from the verified
  session controller. The local namespace is NOT authentication. On restart
  the checkpoint is validated but hidden until a new, successful,
  server-authorized HTTP pull() for that exact scope. A disconnected restart
  therefore shows nothing. With a stale/revoked cursor, HTTP 409 forces
  cursorless rebootstrap and clears the stored snapshot.
- On actor, Area or restore-generation activation, all other note-only
  namespaces are erased. clear() immediately fences in-flight responses and
  wipes all note partitions. 401/404 locks the client and erases note cache.
  Corrupt, content-bearing or future-version records are deleted before
  starting cursorless bootstrap.
- A successful page can publish only after the atomic IndexedDB transaction
  commits the new metadata and cursor together. Failed storage I/O fails closed
  and locks the client. Concurrent pull() calls are serialized per scope;
  epoch fencing prevents delayed requests from recreating purged namespaces.
  A resumed partial bootstrap remains invisible.
- This is NOT end-to-end offline functionality or multi-tab writer
  coordination. There is no offline note edit, UI freshness policy, background
  polling, content cache, session provider, deploy, migration, or production
  activation. A cross-tab single-writer/lease protocol remains necessary before
  using one persistent namespace from multiple tabs, and cached copies cannot
  be remotely erased from already-offline devices.

## Checks

- Unit: node --experimental-loader ./tests/ts-loader.mjs --test tests/target-note-sync-persistent.test.mjs
- Focused Chromium (NOT the full browser E2E suite):
  pnpm exec playwright test --config e2e/playwright.indexeddb.config.ts
- PR Checks: typecheck, all unit tests and build on the exact PR head; full
  browser E2E only at the pre-production release gate.

All test identities, caches and note IDs are synthetic. Tests never touch the
production data folder. Existing default-off HTTP flags remain unchanged.
