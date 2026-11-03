# R2d — Note-only cross-tab IndexedDB lease and atomic checkpoint fencing

This isolated iteration supplies the **cross-tab writer-fencing primitive** for
the default-unused note metadata cache. It **does not activate** note sync or
wire the lease into the existing persistent client. That integration and
cross-tab reader revocation remain subsequent release gates.

## Why it is necessary

`createStagingNotePersistentClient` currently serializes its own HTTP pulls
and IndexedDB checkpoint transactions per JavaScript instance. Two browser
tabs have separate instances, even when they point to the same
`lumi-note-metadata-v1` database. A stale tab may otherwise overwrite a
newer checkpoint or recreate a partition after another tab changes identity.

## v1 lease contract

- `IndexedDbNoteMetadataLease` stores a **single lease for the entire isolated
  note database** in the already-existing `records` object store. It does
  not add an IndexedDB schema migration, touch the task sync database or make
  a new namespace visible to regular `listNamespaces()`.
- `claim()` uses an IndexedDB readwrite transaction on that store. An
  unexpired owner always wins; a second tab gets `busy`. Expiration or
  release advances a durable, monotonically increasing lease epoch on the
  next acquisition. An invalid or exhausted epoch **fails closed**.
- Lease credentials include a random per-instance owner token and the
  persistent epoch. The single lease has a 30-second deadline; `renew()`
  extends only an unexpired matching token and `release()` cannot delete
  a successor's ownership. No timers, polling or background tasks start.
- `marker(namespace)` reads the existing IndexedDB namespace-generation
  marker. `checkpoint(ticket, namespace, marker, value)` checks the **live
  lease and exact namespace marker in the same IndexedDB transaction**
  that writes or deletes `checkpoint`. A suspended/stale owner, expired
  lease or deleted-and-recreated namespace cannot commit. A write is
  validated against the existing strict metadata-only checkpoint format;
  note bodies, titles, credentials or other users' scope cannot be passed.
- This primitive is deliberately **not a session/authentication mechanism**:
  server verification remains mandatory before any persisted data can be
  read by the application. Browser device clocks can be adjusted; real
  integration must treat every failed lease operation as a hard fence and
  hide/wipe its own public manifest. A lease does not remotely erase data
  already present on disconnected devices.

## Follow-up integration required before browser activation

Connect `activate`, all namespace purge/clear operations, every
`pull`/checkpoint and reader invalidation of the note-only client to this
global lease. Do not mix guarded checkpoint commits with unguarded writers
within the same database; do not reuse the task sync queue or namespaces.
Add cross-tab session-revocation and takeover tests at the integration point
before enabling UI. This iteration makes no behavior change to the
default-off client, no server API change, no production deploy and no
data migration.

## Tests

- `e2e/note-lease-indexeddb.spec.ts`: two distinct Chromium tabs on one
  origin compete for a lease; a stale owner is fenced on write/renew/release;
  expiry, takeover and durable epoch increments; namespace marker ABA;
  strict rejection of content-bearing and cross-actor checkpoint values.
- Run via `pnpm exec playwright test --config e2e/playwright.indexeddb.config.ts`.
  This is the **focused** IndexedDB browser suite, not the full Browser E2E
  release gate.
- `PR Checks` must pass typecheck, all unit tests, build and route smoke on
  the exact PR head before merge. No production activation is authorized.
