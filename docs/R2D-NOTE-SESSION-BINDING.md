# R2d — server-authorized note session/Area binding (default-off)

This iteration follows merged #202 and keeps all changes in **isolated,
default-off staging**. It introduces a concrete server proof of the exact
actor/Area/restore-generation tuple, plus a browser adapter that refuses to
publish note metadata unless that proof remains valid around synchronization.

## Trust boundary

- New `GET /api/target-staging/note-sync-session?areaId=...` reuses the same
  note-sync feature flags, durable session cookie verification, staging
  anti-rollback readiness, note child reader and **live read-before-release**
  guard as the note-sync feed. It does not mint credentials. Neither actor nor
  restore generation are accepted from request parameters.
- Responses are only `{ version: 1, scope: { userId, restoreGeneration,
  areaId } }` with `Cache-Control: no-store`. The backend returns 401 for
  invalid/revoked session, 404 for an unauthorized Area, 409 on an unstable
  snapshot and 503 for unavailable staging. No notes, project titles, note
  contents, counts, cursor or membership policy are returned.
- `createStagingNoteSessionBoundClient` performs the proof on `activate`,
  again before **every** `pull`, and again **after** its HTTP result. Scope
  values must exactly match the originally verified actor/Area/generation.
  Any mismatch or 401/404 immediately hides reads, cancels/invalidates
  in-flight results, and erases the note-only cache through the #202 lease.
- An unavailable proof does not authorize reads; failure **after** data fetch
  erases potentially ambiguous persisted state rather than exposing it.
  `invalidate()` explicitly handles sign-out, session switch, Area loss or
  restore notification **synchronously in memory**, with subsequent durable
  clearing. Restarted checkpoints remain hidden until server verification.
- A read gate is purely local; it cannot learn about a revocation at the
  server while a tab is idle or disconnected. The eventual UI/session
  controller MUST invoke `invalidate()` on every local transition and must
  proactively refresh/revalidate before exposing a stale screen. This
  iteration does not pretend that a browser can remotely erase offline data.

## Test plan and release boundary

- Server test: `tests/target-staging-note-sync-http.test.mjs` exercises
  owner, editor, viewer, outsider, cross-Area denial, unknown query keys,
  revoked durable session, and disabled endpoint using isolated synthetic
  staging SQLite state. Production database and credentials are never used.
- Chromium: `e2e/note-session-indexeddb.spec.ts` covers actor switch with
  durable partition wipe, session transition during a delayed HTTP result,
  and malformed/extra-field scope response rejection. Existing two-tab lease
  and checkpoint regression suites run with it.
- Verify the full exact-head `PR Checks` (typecheck, units, build, HTTP smoke)
  and focused `IndexedDB regression (Chromium)` workflow. Full Browser E2E
  remains **exclusively the pre-production release gate**.
- No UI activation, production server flags, real shared account credentials,
  background scheduler, schema migration, or data reset. Session lifecycle
  wiring to the actual React application, freshness and user-visible recovery
  remain the next integration boundary. The optional custom transport is
  only for synthetic tests; real clients use same-origin credentialed GETs.
