# Owner session revocation — security hotfix (2026-11-12)

Scope: one security PR **outside milestone A**. Only the owner cookie `ai_executive_session`; never the already-revocable target durable sessions in `lib/target-staging-durable-session.ts`.

## Issuance and renewal audit
- Password login (`app/api/auth/login/route.ts`) calls `createSessionToken()` after verifying the password.
- Passkey login (`app/api/auth/passkeys/login/verify/route.ts`) calls the **same** `createSessionToken()` after verifying a WebAuthn assertion.
- Passkey registration does **not** issue or refresh a cookie.
- Auth status is read-only. No activity-based refresh or token-renewal route exists in `app/api/auth/**`.

## Revocation contract
- The signed owner payload includes integer `issuedAt` (milliseconds). Old cookies without it and signed cookies older than seven days are rejected.
- A single authoritative `valid_from_ms` integer lives in `$AI_EXECUTIVE_DATA_DIR/owner-session-valid-from.sqlite`, in a dedicated SQLite database with one row. Every owner-cookie check reads it live; `issuedAt > valid_from_ms` is required.
- **No HTTP request initializes or repairs the store.** A missing, invalid, symlinked, unreadable or unsafe-permission state file denies authentication. Password login gets HTTP 503 and passkey login gets HTTP 503, rather than implying invalid credentials.
- Authenticated logout increments the cutoff with `max(Date.now(), previous + 1)` in a synchronous SQLite `BEGIN IMMEDIATE` transaction, then expires the cookie. Every previous owner cookie is rejected across all devices/processes, including legacy and target-staging reads. Concurrent logouts cannot move the cutoff backwards.
- SQLite rollback-journal transactions release write locks automatically after a killed process, unlike persistent directory-based lockfiles. `synchronous=FULL` protects committed updates. No stale-lock cleanup is required.
- `GET /api/store` performs the same owner-cookie validation **after** serializing its response and immediately before release. Target-staging admission/release checks already existed.
- No changes to `lumi_target_staging_session` (durable target sessions), integration bearer tokens, or their independent revocation.

## First deployment — mandatory one-time step
1. Verify every app worker uses the **same private, persistent** `AI_EXECUTIVE_DATA_DIR` on one shared filesystem. The cutoff is not included in ordinary application data backups and **must not be rolled back**.
2. Run **exactly once**, as the service account, with the normal `AI_EXECUTIVE_DATA_DIR` set, **before starting the new app**:
   ```sh
   node --experimental-loader ./tests/ts-loader.mjs scripts/owner-session-revocation-init.mjs
   ```
   This refuses to overwrite any pre-existing file. It creates the initial cutoff and does not issue a token.
3. Deploy the new code, then sign in once on each device. Pre-deployment cookies lack `issuedAt`, so every device must reauthenticate.
4. Normal restarts require **no** initialization command. If the file disappears/is damaged, leave authentication denied, investigate and recover the original state. **Do not just recreate it.** If irrecoverable, rotate `AI_EXECUTIVE_SESSION_SECRET` (invalidating every old signature) *before* an explicitly authorized re-provisioning; restarting or logging in does not reinitialize the file.
5. Never restore an older cutoff snapshot. SQLite requires a local filesystem with functioning cross-process locks. Separate replicas using independent directories are unsupported.

## Regression and verification
`tests/owner-session-revocation.test.mjs`: explicit provisioning, old token refusal, cross-origin/anonymous logout, copied cookie rejected on `/api/store` and `/api/target-staging/tasks`, new login, monotonic concurrent cross-process logouts, durability across process restart, killed write-holder recovery, missing/corrupt/symlinked store refusing login and authenticated requests, and passkey storage-outage classification. Full browser E2E remains a pre-production gate, not a PR gate.
