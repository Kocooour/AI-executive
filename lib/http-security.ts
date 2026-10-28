export class HttpInputError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function readJsonBody<T = unknown>(
  request: Request, maxBytes: number, options: { strictUtf8?: boolean } = {},
): Promise<T> {
  const contentType = request.headers.get("content-type") || "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpInputError("Content-Type must be application/json", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new HttpInputError("Request body is too large", 413);
  if (!request.body) throw new HttpInputError("Request body is required");

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: options.strictUtf8 === true });
  const decode = (value?: Uint8Array, stream = false) => {
    try {
      return decoder.decode(value, { stream });
    } catch (error) {
      if (options.strictUtf8 && error instanceof TypeError) {
        throw new HttpInputError("Request body is not valid UTF-8");
      }
      throw error;
    }
  };
  let received = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new HttpInputError("Request body is too large", 413);
    }
    text += decode(value, true);
  }
  text += decode();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpInputError("Request body is not valid JSON");
  }
}

interface RateWindow {
  count: number;
  resetAt: number;
}

const rateWindows = new Map<string, RateWindow>();

export function trustedClientIdentity(request: Request) {
  // The application listens on loopback and is reached through Tailscale
  // Serve, which owns the forwarding headers. Never use user-agent or an
  // arbitrary header value as a rate-limit key.
  const candidate = (
    request.headers.get("x-forwarded-for")?.split(",", 1)[0] ||
    request.headers.get("x-real-ip") ||
    "proxy-unknown"
  ).trim();
  return candidate.length <= 64 && /^[0-9a-f:.]+$/i.test(candidate)
    ? candidate.toLowerCase()
    : "proxy-unknown";
}

export function enforceRateLimit(
  request: Request,
  bucket: string,
  limit: number,
  windowMs: number,
) {
  const now = Date.now();
  const identity = trustedClientIdentity(request);
  const consume = (key: string, keyLimit: number) => {
    const current = rateWindows.get(key);
    if (!current || current.resetAt <= now) {
      rateWindows.set(key, { count: 1, resetAt: now + windowMs });
      return null;
    }
    current.count += 1;
    return current.count > keyLimit ? current : null;
  };
  // Once one source is blocked it no longer consumes the global budget. The
  // global bucket therefore limits distributed attempts without letting one
  // noisy source lock out the legitimate owner.
  const blocked = consume(`${bucket}:client:${identity}`, limit) ||
    consume(`${bucket}:global`, Math.max(limit * 10, limit + 20));
  if (rateWindows.size > 5000) {
    for (const [key, window] of rateWindows) {
      if (window.resetAt <= now) rateWindows.delete(key);
    }
  }
  if (!blocked) return null;
  return {
    error: "Too many requests",
    status: 429,
    retryAfter: Math.max(1, Math.ceil((blocked.resetAt - now) / 1000)),
  };
}

export function boundedString(value: unknown, name: string, maxLength: number) {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new HttpInputError(`${name} is invalid`);
  }
  return value;
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new HttpInputError("Origin header is required", 403);
  }
  const configuredOrigins = (process.env.AI_EXECUTIVE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedOrigins = new Set([new URL(request.url).origin, ...configuredOrigins]);
  if (!allowedOrigins.has(origin)) {
    throw new HttpInputError("Cross-origin request rejected", 403);
  }
}
