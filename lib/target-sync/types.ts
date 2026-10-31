import type { FeedItem } from "./transport";

/** Why reads are not exposed. `resyncing`: a restore bootstrap is in progress and drafts are not yet migrated. */
export type LockReason = "session_expired" | "restore_pending_reauth" | "resyncing";

/** Local copy of a readable item (task or project). `areaId` is the effective Area. */
export type SyncItem = {
  kind: "task" | "project";
  id: string;
  areaId: string;
  revision: number;
  title: string;
  projectId?: string | null;
  areaKind?: string;
  assignedToMe?: boolean;
  /** Bootstrap that last confirmed the item (the sweep removes items a finished bootstrap did not confirm). */
  bootstrapId: number;
};
export type SyncTombstone = { kind: "task" | "project"; id: string; areaId: string; revision: number };

export type DraftStatus = "queued" | "conflict" | "unsendable" | "local";
/**
 * The user's pending change. `queued`: a command exists; `conflict`: the server refused it (kept, reload offered);
 * `unsendable`: out of sending (404, 400, deleted item), kept while readable; `local`: restored after a backup
 * restore and NEVER sent without an explicit `resubmitDraft`.
 */
export type SyncDraft = {
  taskId: string;
  kind: "title" | "delete";
  title?: string;
  areaId: string;
  /** Feed revision of the item the user based the change on. */
  baseItemRevision: number;
  status: DraftStatus;
  reason: string | null;
  /** Result of `reloadTask` was offered (conflict) so the caller knows to reload, rebase or discard. */
  reloadOffered: boolean;
  commandId: string | null;
};

export type CommandState = "queued" | "sending" | "uncertain" | "frozen";
export type SyncCommand = {
  seq: number;
  commandId: string;
  kind: "title" | "delete";
  taskId: string;
  title?: string;
  /** CAS token; null until acquired (offline edit). Immutable once a send was attempted. */
  expectedRevision: string | null;
  baseItemRevision: number;
  writeAreaId: string;
  restoreGeneration: string;
  state: CommandState;
  attempts: number;
  failures: number;
  notBefore: number;
  /** Re-authorize through the CAS read before the next send (set by `role_changed`). */
  recheck: boolean;
};

export type NamespaceMeta = {
  version: 1;
  userId: string;
  generation: string;
  lock: "session_expired" | "restore_pending_reauth" | null;
  phase: "bootstrap" | "feed";
  cursor: string | null;
  bootstrapId: number;
  /** The running bootstrap re-reads an existing cache (removes what it does not confirm). */
  bootstrapSweep: boolean;
  /** A fresh bootstrap was requested (write `resync_required`, `session_restored`). */
  resyncRequested: boolean;
  /** Old-generation namespaces whose drafts this namespace still has to take over (restore flow). */
  supersedes: string[];
  migrated: boolean;
  nextSeq: number;
  nextReportId: number;
};

export type ReportKind =
  | "left_scope" | "access_lost" | "item_deleted" | "unsendable" | "not_in_bootstrap"
  | "restore" | "session_revoked" | "logout";
export type SyncReport = {
  id: string;
  kind: ReportKind;
  /** Unsendable changes affected (drafts removed or taken out of sending). */
  count: number;
  areaId?: string;
  taskId?: string;
  reason?: string;
  /** Restore: drafts kept as local drafts / removed. */
  keptAsDrafts?: number;
  removed?: number;
};

export type SyncEvent =
  | { type: "report"; userId: string; report: SyncReport }
  | { type: "reauth_required"; userId: string; reason: "session_expired" | "session_restored" }
  | { type: "locked"; userId: string; reason: LockReason }
  | { type: "conflict"; userId: string; taskId: string; commandId: string; code: string }
  | { type: "unsendable"; userId: string; taskId: string; commandId: string | null; reason: string };

export type Readable<T> = { locked: true; reason: LockReason } | { locked: false; value: T };

export type SyncOutcome =
  | { status: "idle" }
  | { status: "locked"; reason: LockReason }
  | { status: "signed_out" }
  | { status: "backoff"; retryAt: number }
  | { status: "error"; reason: string };

export type PumpOutcome =
  | { status: "idle"; done: number; conflicts: number; unsendable: number }
  | { status: "locked"; reason: LockReason }
  | { status: "signed_out" }
  | { status: "resync_requested" }
  | { status: "backoff"; retryAt: number; done: number; conflicts: number; unsendable: number }
  | { status: "error"; reason: string };

export type EditResult =
  | { ok: true; status: DraftStatus; commandId: string | null }
  | { ok: false; reason: "locked" | "inactive" | "invalid_title" | "unknown_task" | "deleted" | "unavailable" | "stale_base" | "busy" | "draft_exists" | "resyncing" | "storage_error" };

export type PendingCounts = {
  drafts: number; queued: number; uncertain: number; conflict: number; unsendable: number; local: number;
};

export type { FeedItem };
