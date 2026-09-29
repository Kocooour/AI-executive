export class HttpInputError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export async function readJsonBody<T = unknown>(request: Request, maxBytes: number): Promise<T> {
  const contentType = request.headers.get("content-type") || "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpInputError("Content-Type must be application/json", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new HttpInputError("Request body is too large", 413);
  if (!request.body) throw new HttpInputError("Request body is required");

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
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
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
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

function requestIdentity(_request: Request) {
  // This deployment has one owner. A global bucket cannot be bypassed with
  // attacker-controlled forwarding or user-agent headers.
  return "single-user";
}

export function enforceRateLimit(
  request: Request,
  bucket: string,
  limit: number,
  windowMs: number,
) {
  const now = Date.now();
  const key = `${bucket}:${requestIdentity(request)}`;
  const current = rateWindows.get(key);
  if (!current || current.resetAt <= now) {
    rateWindows.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  current.count += 1;
  if (current.count <= limit) return null;
  return {
    error: "Too many requests",
    status: 429,
    retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
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
