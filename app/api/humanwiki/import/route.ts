/**
 * HumanWiki H1-real.0: DENY-ONLY server entrypoint.
 *
 * This is intentionally *not* a file upload or import API. No flag,
 * caller consent claim, credential or header may enable this route.
 * Do not call request.json(), text(), formData(), arrayBuffer(), or
 * access the body: the import remains blocked before route-level parsing.
 *
 * A future importer needs a separately reviewed authenticated entry
 * with live owner-private Area ACL, explicit source consent, a durable
 * independent revocation witness and an atomic release barrier.
 */
import {
  denyHumanWikiH1RealImport,
  HumanWikiH1RealEntryBlockedError,
} from "../../../../lib/humanwiki-h1-real-entry.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const blockedResponse = (): Response =>
  Response.json({ error: "Not found" }, { status: 404, headers });

export async function POST(request: Request): Promise<Response> {
  try {
    // The first and only route operation: refuse before inspecting even
    // one property of the request, including headers or the request body.
    denyHumanWikiH1RealImport(request);
  } catch (error) {
    if (!(error instanceof HumanWikiH1RealEntryBlockedError)) throw error;
    return blockedResponse();
  }
  // Fail closed even if a future refactor accidentally changes the guard.
  return blockedResponse();
}
