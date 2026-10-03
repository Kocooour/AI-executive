export interface ClientAuthStatus {
  enabled: boolean;
  configured: boolean;
  authenticated: boolean;
}

export async function fetchClientAuthStatus(timeoutMs = 8000): Promise<ClientAuthStatus> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Authentication status timed out"));
      }, timeoutMs);
    });
    const request = (async () => {
      const response = await fetch("/api/auth/status", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Authentication status is unavailable");
      const status: unknown = await response.json();
      if (!status || typeof status !== "object") throw new Error("Invalid authentication status");
      const value = status as Record<string, unknown>;
      if (typeof value.enabled !== "boolean" || typeof value.configured !== "boolean" || typeof value.authenticated !== "boolean") {
        throw new Error("Invalid authentication status");
      }
      return value as unknown as ClientAuthStatus;
    })();
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
