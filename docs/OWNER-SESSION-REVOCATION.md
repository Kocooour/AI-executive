# Owner session revocation — security hotfix (2026-11-12)

Scope: one independent security PR, **outside milestone A**. Only the main owner cookie `ai_executive_session`; NOT `lib/target-staging-durable-session.ts` or its already-revocable `lumi_target_staging_session`.

## Findings and token issuance

- `app/api/auth/login/route.ts`: after a verified password, invokes `createSessionToken()`.
- `app/api/auth/passkeys/login/verify/route.ts`: after `finishAuthentication()` verifies the WebAuthn assertion, invokes that **same** `createSessionToken()`, setting the same 7-day cookie.
- `app/api/auth/passkeys/register/verify/route.ts`: registers a credential using an existing authenticated cookie; **does not** mint or refresh one.
- `app/api/auth/status/route.ts` only reports `getAuthState()`. No timer-based renewal or refresh endpoint exists among `app/api/auth/**` routes. The cookie is reissued on a successful password or passkey login, not on ordinary activity.

## Server-side contract

- Signed owner payload gains integer `issuedAt` (Unix milliseconds). A token without it is **always rejected**, including all pre-deployment cookies. `expiresAt` still caps validity at seven days.
- `$AI_EXECUTIVE_DATA_DIR/owner-session-valid-from.json` contains the one server-side cutoff `{ "version": 1, "validFromMs": <integer> }`. Verification reads it **live on every request**; valid owner tokens must have `issuedAt > validFromMs`.
- The first **credential-verified login** initializes a *missing* cutoff at the current time, then issues a strictly later timestamp. This is not a read-side fallback: with the marker missing/corrupt/unreadable, **no existing cookie authenticates**. Corruption additionally prevents issuing a new cookie until operator repair.
- Authenticated `POST /api/auth/logout` advances the cutoff to `max(Date.now(), previous + 1)` before clearing the cookie. All owner devices are signed out. Anonymous POST only clears the caller's cookie; it cannot sign out the owner everywhere.
- An exclusive directory lock serializes logout and token issuance **across processes**. The writer reads the current marker while holding the lock, fsyncs a new 0600 file, atomically renames it into place and fsyncs the containing directory. Readers open the marker without following a symlink; missing, corrupt, mispermissioned or inaccessible markers fail closed. A failed authenticated revocation responds 503, not false success.
- Existing legacy API routes enforce `isAuthenticated()` and target-staging owner routes enforce `getAuthState()` at admission (and for target reads again before response release), therefore both paths reject a copied pre-logout cookie.
- No modification to permanent/durable target sessions. These retain their own identity-scoped revocation and are not affected by owner logout.

## Deployment and operations

1. Keep `AI_EXECUTIVE_DATA_DIR` on the **same persistent, private filesystem** for all app workers. Do not put separate replicas on independent data directories; their owner revocation cutoffs would diverge. Do not treat this file as ordinary backup/restore data: restoring an older cutoff may revalidate a previously revoked cookie.
2. After deployment, the old cookies are rejected because they have no `issuedAt`. The owner's first password/passkey login initializes the cutoff; each device then needs to sign in again.
3. If the cutoff is missing or invalid during operation, reads immediately return 401 (fail closed). To recover corrupted state, an operator should preserve the damaged file for investigation and move it out of the directory; only a subsequent successful credential-verified login may bootstrap a fresh cutoff. This discards all earlier sessions. Do not restore a stale cutoff from backup.
4. A stale `.owner-session-valid-from.lock` blocks further issuance/revocation (fail closed). Remove it manually only after confirming no writer process is using it.
5. Cookie logout is intentionally **global**; per-device logout is deferred to R5.

## Regression coverage

`tests/owner-session-revocation.test.mjs` verifies: old signatures without issue time; bootstrap; password login and cookie; 401 for copied cookie at both `/api/store` and `/api/target-staging/tasks` after logout; new login; unauthorized and cross-origin logout; persisted cutoff across a separate Node process; concurrent logout writers; missing, corrupt and symlinked cutoff, with refused reads and refused token issuance. Existing durable-session tests are unchanged.

Full browser E2E remains a pre-production release gate, not a per-PR requirement.
