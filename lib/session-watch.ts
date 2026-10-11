// Notices when the server no longer accepts the session. Every data request of the app goes
// through fetch, so one wrapper sees them all; the app then asks the user to sign in again
// instead of treating the refusals as a lost connection.

// A refused data request means the session ended. Sign-in endpoints answer 401 for their own
// reasons (wrong password, no session yet) and are not a signal.
export function isSessionEnd(url: string, status: number, origin: string): boolean {
  if (status !== 401) return false;
  return isDataRequest(url, origin);
}

// A request for the app's data (any API of this origin except sign-in and access checks).
export function isDataRequest(url: string, origin: string): boolean {
  let target: URL;
  try {
    target = new URL(url, origin);
  } catch {
    return false;
  }
  return target.origin === origin && target.pathname.startsWith("/api/") && !target.pathname.startsWith("/api/auth/");
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const requestUrl = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

// While access could not be checked (an app started without a connection), data requests fail at
// once as "no connection" instead of waiting on a connection that may swallow them; every action
// then ends with its usual offline handling. Sign-in and access checks still go out, so the app
// notices when the server is back.
export function failWhileOffline(fetchImpl: FetchLike, origin: string, offline: () => boolean, message: () => string): FetchLike {
  return (input, init) => {
    if (offline() && isDataRequest(requestUrl(input), origin)) return Promise.reject(new TypeError(message()));
    return fetchImpl(input, init);
  };
}

export function watchSession(fetchImpl: FetchLike, origin: string, onEnded: () => void): FetchLike {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (isSessionEnd(requestUrl(input), response.status, origin)) onEnded();
    return response;
  };
}
