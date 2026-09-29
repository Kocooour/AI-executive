import { createHmac, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
export const sessionCookieName = "ai_executive_session";
export const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;

function derivePassword(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derived) => (error ? reject(error) : resolve(derived as Buffer)),
    );
  });
}

function insecureDevelopmentMode() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.AI_EXECUTIVE_AUTH_ENABLED === "false"
  );
}

function parsePasswordHash(encoded: string) {
  const separator = encoded.startsWith("scrypt:")
    ? ":"
    : encoded.startsWith("scrypt$")
      ? "$"
      : null;
  if (!separator) return null;
  const [scheme, saltValue, hashValue, extra] = encoded.split(separator);
  if (
    scheme !== "scrypt" ||
    !saltValue ||
    !hashValue ||
    extra ||
    !/^[A-Za-z0-9_-]+$/.test(saltValue) ||
    !/^[A-Za-z0-9_-]+$/.test(hashValue)
  ) {
    return null;
  }
  const salt = Buffer.from(saltValue, "base64url");
  const hash = Buffer.from(hashValue, "base64url");
  if (salt.length !== 16 || hash.length !== 64) return null;
  return { salt, hash };
}

function authConfigured() {
  const passwordHash = process.env.AI_EXECUTIVE_PASSWORD_HASH || "";
  const secret = process.env.AI_EXECUTIVE_SESSION_SECRET || "";
  return parsePasswordHash(passwordHash) !== null && secret.length >= 32;
}

function sessionSecret() {
  const secret = process.env.AI_EXECUTIVE_SESSION_SECRET || "";
  if (!insecureDevelopmentMode() && secret.length < 32) {
    throw new Error("AI_EXECUTIVE_SESSION_SECRET must contain at least 32 characters");
  }
  return secret;
}

function encode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function sign(value: string) {
  return createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function cookies(request: Request) {
  return Object.fromEntries(
    (request.headers.get("cookie") || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
          ? [part, ""]
          : [part.slice(0, separator), part.slice(separator + 1)];
      }),
  );
}

export function createSessionToken(maxAgeSeconds = sessionMaxAgeSeconds) {
  const payload = encode(
    JSON.stringify({ subject: "owner", expiresAt: Date.now() + maxAgeSeconds * 1000 }),
  );
  return `${payload}.${sign(payload)}`;
}

export function isAuthenticated(request: Request) {
  if (insecureDevelopmentMode()) return true;
  if (!authConfigured()) return false;
  const token = cookies(request)[sessionCookieName];
  if (!token) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  const expected = sign(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return false;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.subject === "owner" && Number(data.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

export function getAuthState(request: Request) {
  const enabled = !insecureDevelopmentMode();
  const configured = !enabled || authConfigured();
  return {
    enabled,
    configured,
    authenticated: configured && (!enabled || isAuthenticated(request)),
  };
}

export async function verifyPassword(password: string) {
  if (insecureDevelopmentMode()) return false;
  if (!authConfigured()) throw new Error("Authentication is not configured");
  const encoded = process.env.AI_EXECUTIVE_PASSWORD_HASH || "";
  const parsed = parsePasswordHash(encoded);
  if (!parsed) {
    throw new Error("AI_EXECUTIVE_PASSWORD_HASH is not configured correctly");
  }
  const derived = await derivePassword(password, parsed.salt);
  return timingSafeEqual(derived, parsed.hash);
}
