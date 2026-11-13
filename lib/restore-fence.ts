import { NextResponse } from "next/server";
import { currentRestoreKind, getDatabase } from "./server-store";
import { requireSameOrigin } from "./http-security";

// Every owner-session write of an included table carries the restore generation the client knows (the header below, added
// to every non-GET same-origin API request by lib/restore-fence-client.ts). After a restore or import a client that has not
// learned of it yet holds a copy of data that no longer exists; its write is refused here, writing nothing, and the client
// adopts the restored data (a page reload). Requests with the integration API token are not fenced: they hold no client copy
// and are not on owner routes. `store` PUT carries the generation in its body (lib/server-store.ts replaceSnapshot).
export const restoreGenerationHeader = "x-lumi-restore-generation";

/** The refusal, or null when the request may proceed. Generation 0 (never restored) lets everything through. */
export function restoreGenerationMismatch(header: string | null, serverGeneration: number) {
  if (serverGeneration <= 0) return false;
  return header === null || header.trim() !== String(serverGeneration);
}

export function currentRestoreGeneration() {
  const row = getDatabase().prepare("SELECT value FROM metadata WHERE key = 'restoreGeneration'").get() as { value?: string } | undefined;
  return Number(row?.value) || 0;
}

/** Call at the top of every mutating owner route that writes an included table (after the authentication check). */
export function fenceRestoredClient(request: Request): NextResponse | null {
  // A request from another origin (or with none) is refused by the route's own origin check, with its own status.
  try { requireSameOrigin(request); } catch { return null; }
  const generation = currentRestoreGeneration();
  if (!restoreGenerationMismatch(request.headers.get(restoreGenerationHeader), generation)) return null;
  return NextResponse.json(
    { error: "Data was restored", code: "restored", restoreGeneration: generation, restoreKind: currentRestoreKind() },
    { status: 409, headers: { "cache-control": "no-store" } },
  );
}
