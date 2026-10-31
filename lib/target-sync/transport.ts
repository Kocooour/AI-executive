/**
 * R2c.5a transport contract of the target sync client. Every HTTP response of the staging routes is mapped to
 * ONE typed result, so the engine never inspects status codes. The mapping is verified against the route code in
 * app/api/target-staging/** (not only against the docs).
 */
export type FeedItem =
  | { type: "upsert"; kind: "task"; id: string; revision: number; areaId: string; areaKind?: string;
      title: string; projectId?: string | null; effectiveAreaId?: string; assignedToMe?: boolean }
  | { type: "upsert"; kind: "project"; id: string; revision: number; areaId: string; areaKind?: string; title: string }
  | { type: "left_scope"; kind: "task" | "project"; id: string; areaId: string }
  | { type: "tombstone"; kind: "task" | "project"; id: string; areaId: string; revision: number }
  | { type: "access_granted"; areaId: string; role: string; areaCursor?: string }
  | { type: "role_changed"; areaId: string; role: string }
  | { type: "access_lost"; areaId: string };

export type FeedPage = {
  phase: "bootstrap" | "feed" | "area_bootstrap";
  items: FeedItem[];
  /** Bootstrap and feed: another page exists. */
  more: boolean;
  /** Area bootstrap: finished. */
  done: boolean;
  cursor: string | null;
  restoreGeneration: string;
};

/** The command fields shared by title and delete commands (the taskId is part of the URL, not the body). */
export type CommandRequest = {
  taskId: string;
  commandId: string;
  expectedRevision: string;
  writeAreaId: string;
  restoreGeneration: string;
};
export type TitleRequest = CommandRequest & { title: string };
export type CommandStatus = "committed" | "not_recorded";

export type ConflictCode = "stale_revision" | "idempotency_conflict" | "write_area_mismatch" | "unspecified";
export type UnauthorizedCode = "session_expired" | "session_revoked" | "session_restored" | null;

export type TransportResult<T> =
  | { kind: "ok"; value: T; replayed?: boolean }
  | { kind: "conflict"; code: ConflictCode }
  | { kind: "resync_required" }
  | { kind: "read_stale_reload" }
  | { kind: "cursor_invalid" }
  /** 404: unreadable, read-only or deleted for this actor (indistinguishable by design). */
  | { kind: "unavailable" }
  | { kind: "unauthorized"; code: UnauthorizedCode }
  | { kind: "store_unavailable"; code: "restore_pending" | "journal_invalid" | null }
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "invalid"; code: string | null }
  /** Network error, timeout, unparseable body, 5xx outside the known codes: the outcome is unknown. */
  | { kind: "uncertain"; reason: string };

export interface TargetSyncTransport {
  /** `GET /changes[?cursor=]`: bootstrap (null cursor), feed or area bootstrap. */
  fetchChanges(cursor: string | null): Promise<TransportResult<FeedPage>>;
  /** `GET /tasks/{id}/title`: the CAS token a write must present. */
  readTitleToken(taskId: string): Promise<TransportResult<{ snapshotRevision: string }>>;
  sendTitle(request: TitleRequest): Promise<TransportResult<Record<string, never>>>;
  titleStatus(request: TitleRequest): Promise<TransportResult<{ status: CommandStatus }>>;
  sendDelete(request: CommandRequest): Promise<TransportResult<Record<string, never>>>;
  deleteStatus(request: CommandRequest): Promise<TransportResult<{ status: CommandStatus }>>;
}
