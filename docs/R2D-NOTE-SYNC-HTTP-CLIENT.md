# R2d.2c.2g.2b.4b — volatile note sync HTTP transport

This is the **first connected client-side layer** for the metadata-only note
sync contract. `lib/target-sync/note-http.ts` binds the pure reconciler from
#196 to the staging-only, default-off HTTP endpoint being reviewed in #195.
It remains unused by the application, has **no IndexedDB, UI, note content,
offline publishing, local credentials or production activation**.

## Caller contract

An already authenticated session controller must call
`activate({userId,restoreGeneration,areaId})` with **trusted server-derived**
identity and canonical restore generation, not information from the API
response, URL or cursor. Those values are used solely as a volatile partition
fence; they cannot authenticate requests. The server continues to enforce
durable session, policy, Area access, release guards and generation matching.
The client always sends same-origin, no-store, no-redirect GET with browser
credentials and a single encoded `areaId`, `limit=100` and opaque cursor.
It does not supply a bearer token, actor ID or restore generation to the API.

`pull()` processes **one** page per call (except one bounded same-cursor
retry for `read_stale_reload`). The full Area manifest remains unreadable
until bootstrap completes. Changes can only edit/delete previously known
notes; skipped revisions or unseen IDs force a fresh bootstrap. A valid
result updates the in-memory metadata and cursor together.

- Switching actor, Area or generation (including activating the same scope
  again), or calling `clear()` on sign-out/revocation, increments a fence and
  aborts prior requests. Late responses from transports that ignore abort
  cannot publish to the replacement scope.
- 401/404 **locks and discards** the current Area and scope; the
  authenticated controller must re-establish access before a new call.
- 409 `resync_required` or a locally detected journal gap discards the old
  manifest and cursor. Re-bootstrap begins without a cursor on the next pull.
- 409 `read_stale_reload` retries the *identical* cursor once, then returns
  `stale`; it never publishes the rejected HTTP page.
- 400/429/5xx, offline transport, malformed or oversized body leave the
  current in-memory state unchanged and report a non-success to the caller.
  The caller must apply bounded/backoff scheduling; this module never loops
  indefinitely or polls in the background.
- The JSON read is capped at 256 KiB and uses strict UTF-8 decoding. The
  decoder refuses unlisted fields, including note titles and bodies.
- Only one `pull` may run at a time for the currently selected scope.

## Still required before UI or offline activation

This module is deliberately **volatile and default-unused**. An IndexedDB
consumer must persist the manifest and cursor **atomically** under a versioned
partition keyed by authenticated identity, restore generation and Area. It
must validate that partition again on restoration and atomically wipe it on
logout, revoked session, inaccessible Area and generation mismatch. Existing
task/project feeds and queues must not be reused. UI needs explicit freshness,
offline/locked state and policy for already-synced data after losing access;
do not infer authorization from an opaque cursor.

The HTTP producer in PR #195 is still a separate branch; **combined
integration tests on an integration branch** (two or three actors, shared
membership, role and generation revocation mid-page, real cursor, HTTP
edit/delete, abort and 409) are required before connecting this adapter to a
live client. Unit tests here use only mocked `Response` and synthetic IDs.
No background task, migration, database mutation, E2E release test or deploy
is performed by this change.

Reproduction: `node --experimental-loader ./tests/ts-loader.mjs --test tests/target-note-sync-http.test.mjs`
with the repository's supported Node version and dependencies.
