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
        throw new HttpInputError("Request body is not valid JSON");
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

const UNKNOWN_CLIENT = "proxy-unknown";
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function canonicalIp(value: string) {
  const candidate = value.trim().toLowerCase();
  if (!candidate || candidate.length > 64) return null;
  if (IPV4.test(candidate)) return candidate;
  if (!candidate.includes(":") || !/^[0-9a-f:.]+$/.test(candidate)) return null;
  try {
    // WHATWG URL parsing canonicalizes IPv6 text, so equivalent spellings of
    // one address cannot occupy different buckets.
    const host = new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return host;
  } catch {
    return null;
  }
}

export function trustedClientIdentity(request: Request) {
  // Production listens on 127.0.0.1 and is reached only through Tailscale
  // Serve. Serve *replaces* X-Forwarded-For with the tailnet source address
  // (ipn/ipnlocal/serve.go: Header.Set("X-Forwarded-For", SrcAddr)), and
  // `next start` fills the header from the socket only when it is absent.
  // Proxies that append instead of replacing put the address they observed
  // last, so only the LAST hop is proxy-controlled: earlier entries (and
  // X-Real-IP, which Serve never sets) are client-supplied and must not
  // select a rate-limit bucket. Anything unparsable shares one bucket.
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return UNKNOWN_CLIENT;
  const hops = forwarded.split(",");
  return canonicalIp(hops[hops.length - 1]) ?? UNKNOWN_CLIENT;
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
