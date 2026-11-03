/**
 * R2d default-off session boundary for note metadata synchronization.
 * An authenticated server, not the browser, selects user + Area + restore
 * generation. Every pull rechecks this proof before and after data I/O.
 *
 * This is not a session issuer, UI binding, offline edit queue or production
 * activation. The server still authorizes each note-sync GET independently.
 */
import { createStagingNoteLeasedClient, type PersistentNotePullResult } from "./note-persistent";
import type { NoteHttpScope, NoteHttpTransport } from "./note-http";
import type { NoteMetadata } from "./note-pages";

export type NoteSessionActivation =
  | "fresh" | "restored_unverified" | "locked" | "retry" | "superseded";
export type NoteSessionPullResult = PersistentNotePullResult;
export type NoteScopeTransport = (url: string, init: RequestInit) => Promise<Response>;
const ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SCOPE_BYTES = 2048;

function validArea(value: unknown): value is string {
  return typeof value === "string" && !!value && value.trim() === value &&
    value !== "." && value !== ".." && value.isWellFormed() &&
    new TextEncoder().encode(value).length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
const exact = (value: Record<string, unknown>, keys: string): boolean =>
  Object.keys(value).sort().join(",") === keys;

/** Only the exact successful server-derived tuple can authorize the client. */
export function decodeVerifiedNoteScope(value: unknown, requestedArea: string): NoteHttpScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const packet = value as Record<string, unknown>;
  if (!exact(packet, "scope,version") || packet.version !== 1 ||
      !packet.scope || typeof packet.scope !== "object" || Array.isArray(packet.scope))
    return null;
  const s = packet.scope as Record<string, unknown>;
  if (!exact(s, "areaId,restoreGeneration,userId") ||
      typeof s.userId !== "string" || !ID.test(s.userId) ||
      typeof s.restoreGeneration !== "string" || !UUID.test(s.restoreGeneration) ||
      !validArea(s.areaId) || s.areaId !== requestedArea) return null;
  return { userId: s.userId, restoreGeneration: s.restoreGeneration, areaId: s.areaId };
}

async function boundedScope(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return null;
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_SCOPE_BYTES))
    return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SCOPE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
}
type Proof = { kind: "ok"; scope: NoteHttpScope } |
  { kind: "denied" | "unavailable" };

/** Only use injected transports against synthetic test fixtures. */
export function createStagingNoteSessionBoundClient(
  options: { dbName?: string; transport?: NoteHttpTransport;
    scopeTransport?: NoteScopeTransport } = {},
) {
  const core = createStagingNoteLeasedClient({
    dbName: options.dbName, transport: options.transport,
  });
  const transport = options.scopeTransport ?? ((url: string, init: RequestInit) => fetch(url, init));
  let revision = 0;
  let area: string | null = null;
  let scope: NoteHttpScope | null = null;
  let readable = false;
  let disposed = false;
  let pulling = false;

  const prove = async (requestedArea: string): Promise<Proof> => {
    let response: Response;
    try {
      response = await transport("/api/target-staging/note-sync-session?areaId=" +
        encodeURIComponent(requestedArea), {
        method: "GET", credentials: "same-origin", cache: "no-store",
        redirect: "error", headers: { accept: "application/json" },
      });
    } catch {
      return { kind: "unavailable" };
    }
    if (response.status === 401 || response.status === 404)
      return { kind: "denied" };
    if (response.status !== 200)
      return { kind: "unavailable" };
    const checked = decodeVerifiedNoteScope(await boundedScope(response), requestedArea);
    return checked ? { kind: "ok", scope: checked } : { kind: "unavailable" };
  };
  const same = (a: NoteHttpScope, b: NoteHttpScope): boolean =>
    a.userId === b.userId && a.areaId === b.areaId &&
    a.restoreGeneration === b.restoreGeneration;

  /** Immediately fence reads and in-flight responses on signout or any session
   * transition; no remote status call is needed to hide the old manifest. */
  const invalidate = async (): Promise<void> => {
    ++revision;
    readable = false;
    area = null;
    scope = null;
    await core.clear();
  };

  const activate = async (requestedArea: string): Promise<NoteSessionActivation> => {
    const ticket = ++revision;
    readable = false;
    area = null;
    scope = null;
    if (disposed || !validArea(requestedArea)) {
      if (!disposed) await invalidate();
      return "locked";
    }
    const check = await prove(requestedArea);
    if (ticket !== revision) return "superseded";
    if (check.kind !== "ok") {
      // Even if a prior activation was still in flight, a failed new proof
      // must fence and erase any checkpoint it could have written.
      await invalidate();
      return check.kind === "denied" ? "locked" : "retry";
    }
    try {
      const result = await core.activate(check.scope);
      if (ticket !== revision) return "superseded";
      area = requestedArea;
      scope = check.scope;
      // Activation alone, including restored state, never permits reads.
      readable = false;
      return result;
    } catch {
      if (ticket === revision) await invalidate();
      return "retry";
    }
  };

  const pull = async (): Promise<NoteSessionPullResult> => {
    const current = scope;
    const selectedArea = area;
    if (disposed || !current || !selectedArea) return { kind: "inactive" };
    if (pulling) return { kind: "busy" };
    pulling = true;
    const ticket = revision;
    readable = false;
    try {
      const before = await prove(selectedArea);
      if (ticket !== revision) return { kind: "superseded" };
      if (before.kind === "denied" ||
          (before.kind === "ok" && !same(before.scope, current))) {
        await invalidate();
        return { kind: "locked" };
      }
      if (before.kind !== "ok") return { kind: "retry" };
      const result = await core.pull();
      if (ticket !== revision) return { kind: "superseded" };
      if (result.kind === "locked" || result.kind === "storage_error") {
        await invalidate();
        return result;
      }
      // The HTTP result is held behind the wrapper's read gate until the
      // server confirms the SAME actor, Area and restore generation again.
      const after = await prove(selectedArea);
      if (ticket !== revision) return { kind: "superseded" };
      if (after.kind === "denied" ||
          (after.kind === "ok" && !same(after.scope, current))) {
        await invalidate();
        return { kind: "locked" };
      }
      if (after.kind !== "ok") {
        await invalidate(); // ambiguous mid-flight cookie change: fail closed
        return { kind: "retry" };
      }
      if (result.kind === "applied") readable = true;
      return result;
    } catch {
      if (ticket === revision) await invalidate();
      return { kind: "storage_error" };
    } finally {
      pulling = false;
    }
  };

  return {
    activate, pull, invalidate,
    read: (): NoteMetadata[] => readable && !disposed ? core.read() : [],
    currentScope: (): NoteHttpScope | null =>
      readable && !disposed && scope && core.currentScope() ? { ...scope } : null,
    dispose: async (): Promise<void> => {
      disposed = true;
      ++revision;
      readable = false;
      area = null;
      scope = null;
      await core.dispose();
    },
  };
}
