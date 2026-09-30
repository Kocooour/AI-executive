import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoUint8Array } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { HttpInputError } from "./http-security";
import {
  consumePasskeyChallenge,
  getPasskey,
  listPasskeys,
  savePasskey,
  savePasskeyChallenge,
  updatePasskeyUse,
} from "./server-store";

const challengeLifetimeMs = 5 * 60_000;

function configuredOrigins() {
  return (process.env.AI_EXECUTIVE_PASSKEY_ORIGINS || process.env.AI_EXECUTIVE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.hostname !== "localhost") {
        throw new Error("Passkey origins must use HTTPS except for localhost");
      }
      return { origin: url.origin, rpId: url.hostname };
    });
}

export function passkeyRequestContext(request: Request) {
  const origin = request.headers.get("origin") || "";
  const configured = configuredOrigins().find((item) => item.origin === origin);
  if (!configured) throw new HttpInputError("Passkeys are unavailable for this origin", 403);
  return configured;
}

export async function registrationOptions(
  request: Request,
  binding: string,
) {
  const { origin, rpId } = passkeyRequestContext(request);
  const credentials = listPasskeys(rpId);
  const options = await generateRegistrationOptions({
    rpName: "AI Executive",
    rpID: rpId,
    userID: isoUint8Array.fromUTF8String("ai-executive-owner-v1"),
    userName: "owner",
    userDisplayName: "AI Executive owner",
    timeout: challengeLifetimeMs,
    attestationType: "none",
    excludeCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: credential.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  savePasskeyChallenge(
    options.challenge,
    "registration",
    rpId,
    origin,
    binding,
    Date.now() + challengeLifetimeMs,
  );
  return options;
}

export async function finishRegistration(
  request: Request,
  binding: string,
  challenge: string,
  response: RegistrationResponseJSON,
  label: string,
) {
  const { origin, rpId } = passkeyRequestContext(request);
  if (!consumePasskeyChallenge(challenge, "registration", rpId, origin, binding)) {
    throw new HttpInputError("Passkey registration expired or was already used", 400);
  }
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserPresence: true,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new HttpInputError("Passkey registration failed", 400);
  }
  const info = verification.registrationInfo;
  savePasskey({
    id: info.credential.id,
    publicKey: info.credential.publicKey,
    counter: info.credential.counter,
    transports: (info.credential.transports || response.response.transports || []) as string[],
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    rpId,
    label: label || "Passkey",
    createdAt: Date.now(),
    lastUsedAt: null,
  });
  return info.credential.id;
}

export async function authenticationOptions(request: Request) {
  const { origin, rpId } = passkeyRequestContext(request);
  const credentials = listPasskeys(rpId);
  if (!credentials.length) throw new HttpInputError("No passkey is registered for this address", 404);
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    timeout: challengeLifetimeMs,
    userVerification: "required",
    allowCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: credential.transports as AuthenticatorTransportFuture[],
    })),
  });
  savePasskeyChallenge(
    options.challenge,
    "authentication",
    rpId,
    origin,
    "",
    Date.now() + challengeLifetimeMs,
  );
  return options;
}

export async function finishAuthentication(
  request: Request,
  challenge: string,
  response: AuthenticationResponseJSON,
) {
  const { origin, rpId } = passkeyRequestContext(request);
  if (!consumePasskeyChallenge(challenge, "authentication", rpId, origin, "")) {
    throw new HttpInputError("Passkey sign-in expired or was already used", 400);
  }
  const stored = getPasskey(response.id, rpId);
  if (!stored) throw new HttpInputError("Passkey sign-in failed", 401);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
    credential: {
      id: stored.id,
      publicKey: Uint8Array.from(stored.publicKey),
      counter: stored.counter,
      transports: stored.transports as AuthenticatorTransportFuture[],
    },
  });
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    throw new HttpInputError("Passkey sign-in failed", 401);
  }
  updatePasskeyUse(
    stored.id,
    verification.authenticationInfo.newCounter,
    verification.authenticationInfo.credentialBackedUp,
  );
  return stored.id;
}

export function passkeySummaries() {
  return listPasskeys().map(({ id, label, rpId, createdAt, lastUsedAt, backedUp }) => ({
    id,
    label,
    rpId,
    createdAt,
    lastUsedAt,
    backedUp,
  }));
}
