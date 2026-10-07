// Notices when the server no longer accepts the session. Every data request of the app goes
// through fetch, so one wrapper sees them all; the app then asks the user to sign in again
// instead of treating the refusals as a lost connection.

// A refused data request means the session ended. Sign-in endpoints answer 401 for their own
// reasons (wrong password, no session yet) and are not a signal.
export function isSessionEnd(url: string, status: number, origin: string): boolean {
  if (status !== 401) return false;
  let target: URL;
  try {
    target = new URL(url, origin);
  } catch {
    return false;
  }
  return target.origin === origin && target.pathname.startsWith("/api/") && !target.pathname.startsWith("/api/auth/");
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function watchSession(fetchImpl: FetchLike, origin: string, onEnded: () => void): FetchLike {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isSessionEnd(url, response.status, origin)) onEnded();
    return response;
  };
}
