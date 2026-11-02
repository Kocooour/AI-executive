/**
 * R2d.2c.2g.2b.4b — default-unused, volatile staging note metadata HTTP client.
 *
 * Identity and restore generation MUST be supplied by a verified session owner,
 * never from a URL, cursor or HTTP response. This is not a login/session manager
 * or an offline cache. No browser persistence, note content, UI or write queue.
 */
import {
  applyNoteSyncPage, emptyNoteSyncPageState, readableNoteMetadata,
  type NoteMetadata, type NoteSyncPageState,
} from "./note-pages";

export type NoteHttpScope = Readonly<{
  userId: string;
  restoreGeneration: string;
  areaId: string;
}>;
export type NoteHttpPullResult =
  | { kind: "applied"; phase: "bootstrap" | "changes"; more: boolean }
  | { kind: "resync_required" | "locked" | "stale" | "retry" | "invalid_response" | "superseded" | "inactive" | "busy" };

export type NoteHttpTransport = (url: string, init: RequestInit) => Promise<Response>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER = /^[A-Za-z0-9_.:@-]{1,120}$/;
const MAX_BYTES = 256 * 1024;
const areaIdValid = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.trim() === s &&
  s !== "." && s !== ".." && s.isWellFormed() &&
  new TextEncoder().encode(s).length <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(s);
function validScope(s: NoteHttpScope): boolean {
  return s !== null && typeof s === "object" &&
    USER.test(s.userId) && typeof s.restoreGeneration === "string" &&
    UUID.test(s.restoreGeneration) && areaIdValid(s.areaId);
}

/** Fail closed on unlimited, malformed, non-UTF-8 or content-bearing responses. */
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return null;
  const header = response.headers.get("content-length");
  if (header !== null && (!/^\d+$/.test(header) || Number(header) > MAX_BYTES)) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
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

function is409Code(value: unknown): value is { code: "read_stale_reload" | "resync_required" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return Object.keys(obj).length === 1 && Object.hasOwn(obj, "code") &&
    (obj.code === "read_stale_reload" || obj.code === "resync_required");
}

/**
 * Exactly one active Area at a time. Re-activating even the same scope starts a
 * fresh bootstrap and fences all in-flight responses. Reads never publish an
 * incomplete bootstrap. 401/404 lock and remove the active scope; 409 resync
 * discards the old manifest. A stale read retries the SAME cursor at most once.
 */
export function createStagingNoteHttpClient(
  transport: NoteHttpTransport = (url, init) => fetch(url, init),
) {
  let scope: NoteHttpScope | null = null;
  let generation = 0;
  let state: NoteSyncPageState = emptyNoteSyncPageState();
  let pendingFor: number | null = null;
  let abort: AbortController | null = null;

  const clear = () => {
    generation++;
    abort?.abort();
    abort = null;
    pendingFor = null;
    scope = null;
    state = emptyNoteSyncPageState();
  };
  const activate = (next: NoteHttpScope) => {
    if (!validScope(next)) throw new TypeError("Invalid authenticated note scope");
    clear();
    scope = { userId: next.userId, restoreGeneration: next.restoreGeneration.toLowerCase(),
      areaId: next.areaId };
  };
  const currentScope = (): NoteHttpScope | null => scope ? { ...scope } : null;
  const read = (): NoteMetadata[] => scope ? readableNoteMetadata(state) : [];

  const pull = async (): Promise<NoteHttpPullResult> => {
    if (!scope) return { kind: "inactive" };
    if (pendingFor === generation) return { kind: "busy" };
    const ticket = generation;
    const selected = scope;
    const controller = new AbortController();
    abort = controller;
    pendingFor = ticket;
    const active = () => generation === ticket && scope === selected;
    try {
      // Two attempts maximum; both use the same exact state/cursor.
      for (let attempt = 0; attempt < 2; attempt++) {
        const params = new URLSearchParams({ areaId: selected.areaId, limit: "100" });
        if (state.cursor !== null) params.set("cursor", state.cursor);
        let response: Response;
        try {
          response = await transport("/api/target-staging/note-sync?" + params.toString(), {
            method: "GET", credentials: "same-origin", cache: "no-store",
            redirect: "error", headers: { accept: "application/json" },
            signal: controller.signal,
          });
        } catch {
          return { kind: active() ? "retry" : "superseded" };
        }
        if (!active()) return { kind: "superseded" };
        if (response.status === 401 || response.status === 404) {
          clear();
          return { kind: "locked" };
        }
        if (response.status === 409) {
          const body = await boundedJson(response);
          if (!active()) return { kind: "superseded" };
          if (!is409Code(body)) return { kind: "invalid_response" };
          if (body.code === "resync_required") {
            state = emptyNoteSyncPageState();
            return { kind: "resync_required" };
          }
          if (attempt === 0) continue;
          return { kind: "stale" };
        }
        if (response.status !== 200) return { kind: "retry" };
        const body = await boundedJson(response);
        if (!active()) return { kind: "superseded" };
        const next = applyNoteSyncPage(state, body);
        if (!next.ok) {
          if (next.reason === "resync_required") {
            state = emptyNoteSyncPageState();
            return { kind: "resync_required" };
          }
          return { kind: "invalid_response" };
        }
        state = next.state;
        return { kind: "applied", phase: state.phase, more: (body as { more: boolean }).more };
      }
      return { kind: "stale" };
    } finally {
      if (pendingFor === ticket) pendingFor = null;
      if (abort === controller) abort = null;
    }
  };
  return { activate, clear, currentScope, read, pull };
}
