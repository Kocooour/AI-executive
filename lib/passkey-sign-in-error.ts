/** Distinguish verified WebAuthn issuance outages from bad assertions.
 * Next.js route modules may only export handlers and route metadata.
 */
import { HttpInputError } from "./http-security";
import { OwnerSessionStateUnavailable } from "./owner-session-revocation";

export function passkeySignInError(error: unknown): HttpInputError {
  return error instanceof HttpInputError ? error
    : error instanceof OwnerSessionStateUnavailable
      ? new HttpInputError("Passkey sign-in is unavailable", 503)
      : new HttpInputError("Passkey sign-in failed", 401);
}
