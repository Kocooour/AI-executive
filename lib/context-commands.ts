import { createHash, randomUUID } from "node:crypto";
import { getDatabase, readSnapshot } from "./server-store";

// The one write path for Context Graph objects (claims, standalone subjects, ...).
// A command carries an idempotency key, the object id, an explicit workspace and, where it
// applies, the expected revision. The object change, its change history and the stored command
// result are committed in ONE transaction: any failure leaves none of the three behind.

export class ContextCommandError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "invalid") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const contextIdPattern = /^[A-Za-z0-9:_-]{1,240}$/;

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertCommandWorkspace(workspaceId: string) {
  if (!workspaceId || workspaceId === "all") throw new ContextCommandError("One explicit workspace is required");
  const exists = readSnapshot().entities.some((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId);
  if (!exists) throw new ContextCommandError("Workspace not found", 404, "workspace_not_found");
}

/** Test seam for forcing a failure inside the transaction. Never reachable from the API. */
export interface CommandHooks {
  afterMutate?: () => void;
  beforeCommit?: () => void;
}

export interface CommandMutation<T> {
  result: T;
  objectId: string;
  operation: string;
  before: { revision: number; payload: unknown } | null;
  after: { revision: number; payload: unknown };
  changed: boolean;
  /** Undo/Redo only: what kind of step this is and the event it reverses. Ordinary changes omit both. */
  kind?: "change" | "undo" | "redo" | "skip";
  revertsEventId?: string;
  objectType?: "claim" | "subject";
}

export interface CommandRequest<T> {
  /** Name stored in history, e.g. "create", "update", "subject.rename". */
  operation: string;
  commandId: string;
  workspaceId: string;
  /** The complete request; two requests with the same key must hash equal to count as a retry. */
  request: unknown;
  mutate: () => CommandMutation<T>;
  hooks?: CommandHooks;
}

export function runContextCommand<T extends object>(command: CommandRequest<T>): T & { replayed: boolean; changed: boolean; historyEventId: string | null } {
  if (!contextIdPattern.test(command.commandId)) throw new ContextCommandError("Idempotency key is invalid");
  assertCommandWorkspace(command.workspaceId);
  const database = getDatabase();
  const hash = createHash("sha256").update(`${command.operation}:${stableStringify(command.request)}`).digest("hex");
  database.exec("BEGIN IMMEDIATE");
  try {
    const prior = database.prepare(`SELECT request_hash, result_payload FROM context_commands
      WHERE workspace_id = ? AND idempotency_key = ?`).get(command.workspaceId, command.commandId) as
      { request_hash: string; result_payload: string } | undefined;
    if (prior) {
      if (prior.request_hash !== hash) {
        throw new ContextCommandError("Idempotency key was already used for another command", 409, "idempotency_conflict");
      }
      database.exec("COMMIT");
      return { ...JSON.parse(prior.result_payload), replayed: true } as T & { replayed: boolean; changed: boolean; historyEventId: string | null };
    }
    const mutation = command.mutate();
    command.hooks?.afterMutate?.();
    const eventId = randomUUID();
    if (mutation.changed) {
      database.prepare(`INSERT INTO context_change_events
        (id, command_id, workspace_id, actor, object_id, operation, before_revision, after_revision,
         before_payload, after_payload, created_at, sequence, object_type, kind, reverts_event_id)
        VALUES (?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?, ?,
          (SELECT COALESCE(MAX(sequence), 0) + 1 FROM context_change_events), ?, ?, ?)`)
        .run(eventId, command.commandId, command.workspaceId, mutation.objectId, mutation.operation,
          mutation.before?.revision ?? null, mutation.after.revision,
          mutation.before ? JSON.stringify(mutation.before.payload) : null, JSON.stringify(mutation.after.payload), Date.now(),
          mutation.objectType ?? (mutation.operation.startsWith("subject.") ? "subject" : "claim"),
          mutation.kind ?? "change", mutation.revertsEventId ?? null);
    }
    // The id of the history step this command recorded (null for a no-op); a retry returns the original one.
    const result = { ...mutation.result, replayed: false, changed: mutation.changed, historyEventId: mutation.changed ? eventId : null };
    database.prepare(`INSERT INTO context_commands
      (workspace_id, idempotency_key, request_hash, result_payload, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(command.workspaceId, command.commandId, hash, JSON.stringify(result), Date.now());
    command.hooks?.beforeCommit?.();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* already rolled back by SQLite */ }
    throw error;
  }
}

/** Fails when an optimistic UPDATE ... WHERE revision = ? touched no row. */
export function requireChanged(info: { changes: number | bigint }, message: string) {
  if (Number(info.changes) !== 1) throw new ContextCommandError(message, 409, "revision_conflict");
}
