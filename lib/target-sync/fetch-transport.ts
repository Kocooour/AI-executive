import { TARGET_PROTOCOL_HEADER, TARGET_PROTOCOL_VERSION } from "../target-staging-write-contract";
import type {
  CommandRequest, CommandStatus, ConflictCode, FeedPage, TargetSyncTransport, TitleRequest, TransportResult,
  UnauthorizedCode,
} from "./transport";

export type FetchTransportOptions = {
  fetch?: typeof fetch;
  /** Default `/api/target-staging`. */
  baseUrl?: string;
  /** Per-request timeout (default 15 s); a timeout is an `uncertain` result, never a failure of the command. */
  timeoutMs?: number;
};

type Json = Record<string, unknown>;
const asJson = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

/** Maps a non-2xx response (already read) to the typed union. `write` marks commands (409 body codes differ). */
function mapFailure(status: number, body: Json | null, headers: Headers): TransportResult<never> {
  const code = typeof body?.code === "string" ? body.code : null;
  if (status === 401) {
    const known: UnauthorizedCode = code === "session_expired" || code === "session_revoked" || code === "session_restored"
      ? code : null;
    return { kind: "unauthorized", code: known };
  }
  if (status === 404) return { kind: "unavailable" };
  if (status === 429) {
    const header = headers.get("retry-after");
    const raw = header === null || header.trim() === "" ? Number.NaN : Number(header);
    return { kind: "rate_limited", retryAfterSeconds: Number.isFinite(raw) && raw >= 0 ? raw : null };
  }
  if (status === 400) return code === "cursor_invalid" ? { kind: "cursor_invalid" } : { kind: "invalid", code };
  if (status === 409) {
    if (code === "resync_required") return { kind: "resync_required" };
    if (code === "read_stale_reload") return { kind: "read_stale_reload" };
    const known: ConflictCode = code === "stale_revision" || code === "idempotency_conflict" || code === "write_area_mismatch"
      ? code : "unspecified";
    return { kind: "conflict", code: known };
  }
  if (status === 503) {
    return { kind: "store_unavailable", code: code === "restore_pending" || code === "journal_invalid" ? code : null };
  }
  if (status >= 400 && status < 500) return { kind: "invalid", code };
  return { kind: "uncertain", reason: `http_${status}` };
}

function validFeedPage(value: Json | null): value is Json & FeedPage {
  return !!value && (value.phase === "bootstrap" || value.phase === "feed" || value.phase === "area_bootstrap") &&
    Array.isArray(value.items) && typeof value.restoreGeneration === "string" && value.restoreGeneration.length > 0 &&
    (value.cursor === null || typeof value.cursor === "string");
}

/**
 * `fetch` based transport. Every write sends `x-lumi-target-protocol: 1`, `credentials: same-origin` and the
 * `writeAreaId` + `restoreGeneration` fields. The browser adds the `Origin` header the routes require.
 */
export function createFetchTransport(options: FetchTransportOptions = {}): TargetSyncTransport {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const base = (options.baseUrl ?? "/api/target-staging").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const taskUrl = (taskId: string, suffix: string) => `${base}/tasks/${encodeURIComponent(taskId)}${suffix}`;

  async function call<T>(url: string, init: RequestInit, parse: (body: Json | null, response: Response) => T | null): Promise<TransportResult<T>> {
    let response: Response;
    try {
      const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined;
      response = await doFetch(url, { ...init, credentials: "same-origin", cache: "no-store", signal });
    } catch (error) {
      return { kind: "uncertain", reason: error instanceof Error ? error.name || "network" : "network" };
    }
    let body: Json | null = null;
    try { body = asJson(await response.json()); } catch { body = null; }
    if (response.status >= 200 && response.status < 300) {
      const parsed = parse(body, response);
      if (parsed === null) return { kind: "uncertain", reason: "unparseable_body" };
      return { kind: "ok", value: parsed, ...(body?.replayed === true ? { replayed: true } : {}) };
    }
    return mapFailure(response.status, body, response.headers);
  }

  const writeInit = (method: "PATCH" | "POST", fields: Json): RequestInit => ({
    method,
    headers: { "content-type": "application/json", [TARGET_PROTOCOL_HEADER]: TARGET_PROTOCOL_VERSION },
    body: JSON.stringify(fields),
  });
  const commandFields = (request: CommandRequest): Json => ({
    commandId: request.commandId, expectedRevision: request.expectedRevision,
    writeAreaId: request.writeAreaId, restoreGeneration: request.restoreGeneration,
  });
  const titleFields = (request: TitleRequest): Json => ({ ...commandFields(request), title: request.title });
  const okOnly = (body: Json | null) => (body && body.ok === true ? ({} as Record<string, never>) : null);
  const statusOf = (body: Json | null): { status: CommandStatus } | null =>
    body && (body.status === "committed" || body.status === "not_recorded") ? { status: body.status } : null;

  return {
    fetchChanges: cursor => call(`${base}/changes${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
      { method: "GET" }, body => (validFeedPage(body)
        ? ({ ...body, more: body.more === true, done: body.done === true } as FeedPage) : null)),
    readTitleToken: taskId => call(taskUrl(taskId, "/title"), { method: "GET" },
      body => (body && typeof body.snapshotRevision === "string" ? { snapshotRevision: body.snapshotRevision } : null)),
    sendTitle: request => call(taskUrl(request.taskId, "/title"), writeInit("PATCH", titleFields(request)), okOnly),
    titleStatus: request => call(taskUrl(request.taskId, "/title/status"), writeInit("POST", titleFields(request)), statusOf),
    sendDelete: request => call(taskUrl(request.taskId, "/delete"), writeInit("POST", commandFields(request)), okOnly),
    deleteStatus: request => call(taskUrl(request.taskId, "/delete/status"), writeInit("POST", commandFields(request)), statusOf),
  };
}
