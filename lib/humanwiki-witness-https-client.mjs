/**
 * H1-real.4b: real, bounded HTTPS transport for an out-of-process witness.
 * This sends only a registry ID and a freshly generated verifier nonce.
 * It NEVER submits raw SQLite records, identities, consents or private content.
 *
 * The operator must configure a truly independent recovery domain; TLS and
 * signature verification do not prove that the operator did so.
 */
import { isIP } from "node:net";

export const HUMANWIKI_WITNESS_CHALLENGE_PATH =
  "/v1/humanwiki/high-water/challenge";
const MAX_RECEIPT_BYTES = 1024;
const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export function humanWikiWitnessHttpsOrigin(value) {
  try {
    if (typeof value !== "string" || value.length > 300) return null;
    const url = new URL(value);
    const host = url.hostname;
    if (url.protocol !== "https:" || url.origin !== value ||
        url.username || url.password || url.search || url.hash ||
        url.pathname !== "/" || url.port ||
        !DOMAIN.test(host) || !host.includes(".") || isIP(host) ||
        host === "localhost" || host.endsWith(".localhost") ||
        host.endsWith(".local") || host.endsWith(".internal") ||
        host.endsWith(".onion")) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * The callback is compatible with verifyHumanWikiFreshWitnessPreflight:
 * getFreshReceipt({registryId,nonce,signal}). The caller owns its AbortSignal.
 * Redirects, invalid content-type, oversized or malformed replies fail closed.
 * No caller can inject a URL/path, token, header or private content.
 */
export function createHumanWikiWitnessHttpsReceiptProvider(origin, fetchImpl = fetch) {
  if (!humanWikiWitnessHttpsOrigin(origin) || typeof fetchImpl !== "function")
    throw Error("unavailable");

  return async ({ registryId, nonce, signal }) => {
    if (typeof registryId !== "string" || typeof nonce !== "string" ||
        !(signal instanceof AbortSignal) || signal.aborted)
      throw Error("unavailable");
    const response = await fetchImpl(origin + HUMANWIKI_WITNESS_CHALLENGE_PATH, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ registryId, nonce }),
      signal,
    });
    if (signal.aborted || response.status !== 200 ||
        response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
          "application/json" ||
        !response.body) throw Error("unavailable");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) ||
        Number(declared) > MAX_RECEIPT_BYTES)) throw Error("unavailable");

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw Error("unavailable");
        total += value.byteLength;
        if (total > MAX_RECEIPT_BYTES) throw Error("unavailable");
        chunks.push(value);
      }
    } catch (error) {
      try { await reader.cancel(); } catch { /* already aborted */ }
      throw error;
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    if (signal.aborted || total === 0) throw Error("unavailable");
    const bytes = Buffer.concat(chunks, total);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  };
}
