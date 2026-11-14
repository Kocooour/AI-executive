import { offlineRecoveryIsHeld } from "./d2b-recovery-hold";
import { isCrossTabAdoptionBlocked } from "./owner-adoption-barrier";
// The client half of the restore fence (lib/restore-fence.ts): one wrapper around fetch, installed once at app start, adds the
// restore generation this page knows to every non-GET same-origin request to /api/*, so no call site can miss it, and hands a
// 409 `restored` answer to the single adoption path (a reload with the restored data). `/api/store` carries the generation in
// its body and handles its own answer; the integration API is not called from the app.
export const restoreGenerationHeader = "x-lumi-restore-generation";

type Hooks = { generation: () => number | undefined; onRestored: (observedGeneration: number | undefined, restoreKind: unknown) => void };

export function installRestoreFence(hooks: Hooks) {
  const target = window as unknown as { fetch: typeof fetch; __lumiRestoreFence?: boolean };
  if (target.__lumiRestoreFence) return;
  target.__lumiRestoreFence = true;
  const original = target.fetch.bind(window);
  target.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: URL;
    try { url = new URL(input instanceof Request ? input.url : String(input), window.location.href); } catch { return original(input, init); }
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const mutatingApi = url.origin === window.location.origin && url.pathname.startsWith("/api/")
      && !["GET", "HEAD", "OPTIONS"].includes(method);
    // Sign-in (password/passkey) must still work after a reload or session expiry,
    // otherwise the owner could not download locally preserved recovery data.
    const recoveryLogin = method === "POST" && [
      "/api/auth/login", "/api/auth/passkeys/login/options", "/api/auth/passkeys/login/verify",
    ].includes(url.pathname);
    if (mutatingApi && (offlineRecoveryIsHeld() || isCrossTabAdoptionBlocked()) && !recoveryLogin)
      throw new Error("OFFLINE_RECOVERY_HELD");
    const guarded = mutatingApi && url.pathname !== "/api/store";
    if (!guarded) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const generation = hooks.generation();
    if (generation !== undefined) headers.set(restoreGenerationHeader, String(generation));
    const response = await original(input, { ...init, headers });
    if (response.status === 409) {
      const answer = await response.clone().json().catch(() => null) as { code?: string; restoreGeneration?: unknown; restoreKind?: unknown } | null;
      if (answer?.code === "restored") {
        const generation = answer.restoreGeneration;
        hooks.onRestored(typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0
          ? generation : undefined, answer.restoreKind);
      }
    }
    return response;
  };
}
