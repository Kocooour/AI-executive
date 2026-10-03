import { createHash, randomUUID } from "node:crypto";
import { getDatabase, readSnapshot } from "./server-store";

export type StandaloneSubjectType = "person" | "organization";
export interface StandaloneSubject {
  id: string;
  workspaceId: string;
  type: StandaloneSubjectType;
  canonicalEntityId: null;
  title: string;
  revision: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export class ContextSubjectError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "invalid") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type SubjectRow = {
  id: string; workspace_id: string; subject_type: string; canonical_entity_id: string | null;
  display_title: string; revision: number; archived_at: number | null; created_at: number; updated_at: number;
};
const idPattern = /^[A-Za-z0-9:_-]{1,240}$/;
const titlePattern = /\S/u;

function assertWorkspace(workspaceId: string) {
  if (!workspaceId || workspaceId === "all" || !readSnapshot().entities.some((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId)) {
    throw new ContextSubjectError("Workspace not found", 404, "workspace_not_found");
  }
}

function normalizeTitle(title: string) {
  return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("cs-CZ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function cleanTitle(title: string) {
  const value = title.trim().replace(/\s+/g, " ");
  if (!titlePattern.test(value) || value.length > 200) throw new ContextSubjectError("Name must contain 1–200 characters");
  return value;
}

function deserialize(row: SubjectRow): StandaloneSubject {
  return { id: row.id, workspaceId: row.workspace_id, type: row.subject_type as StandaloneSubjectType,
    canonicalEntityId: null, title: row.display_title, revision: Number(row.revision),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

function rowFor(id: string, workspaceId: string) {
  return getDatabase().prepare(`SELECT * FROM context_subjects WHERE id = ? AND workspace_id = ?
    AND canonical_entity_id IS NULL AND subject_type IN ('person', 'organization')`).get(id, workspaceId) as SubjectRow | undefined;
}

export function getStandaloneSubject(workspaceId: string, id: string) {
  assertWorkspace(workspaceId);
  if (!idPattern.test(id)) throw new ContextSubjectError("Invalid subject identifier");
  const row = rowFor(id, workspaceId);
  if (!row) throw new ContextSubjectError("Person or organization not found", 404, "not_found");
  return deserialize(row);
}

export function listStandaloneSubjects(workspaceId: string, options: { includeArchived?: boolean; query?: string } = {}) {
  assertWorkspace(workspaceId);
  const query = String(options.query || "").trim();
  if (query.length > 200) throw new ContextSubjectError("Search is too long");
  const rows = getDatabase().prepare(`SELECT * FROM context_subjects WHERE workspace_id = ?
    AND canonical_entity_id IS NULL AND subject_type IN ('person', 'organization')
    ${options.includeArchived ? "" : "AND archived_at IS NULL"}
    ORDER BY updated_at DESC LIMIT 1000`).all(workspaceId) as unknown as SubjectRow[];
  const needle = normalizeTitle(query);
  return rows.map(deserialize).filter((subject) => !needle || normalizeTitle(subject.title).includes(needle));
}

export function matchingStandaloneSubjects(workspaceId: string, type: StandaloneSubjectType, title: string) {
  const name = normalizeTitle(title);
  return listStandaloneSubjects(workspaceId).filter((subject) => subject.type === type &&
    (normalizeTitle(subject.title) === name || (name.length >= 3 &&
      (normalizeTitle(subject.title).includes(name) || name.includes(normalizeTitle(subject.title))))));
}

type SubjectCommand = {
  commandId: string; workspaceId: string; id: string; expectedRevision: number;
  type?: StandaloneSubjectType; title?: string;
};

function runCommand(operation: "create" | "rename" | "archive", input: SubjectCommand) {
  if (!idPattern.test(input.commandId) || !idPattern.test(input.id)) throw new ContextSubjectError("Invalid command or subject identifier");
  if (operation === "create" && input.id.startsWith("canonical:")) {
    throw new ContextSubjectError("Subject identifier uses a reserved prefix", 400, "reserved_subject_id");
  }
  assertWorkspace(input.workspaceId);
  const title = operation === "archive" ? undefined : cleanTitle(String(input.title || ""));
  if (operation === "create" && input.type !== "person" && input.type !== "organization") throw new ContextSubjectError("Invalid subject type");
  const requestHash = createHash("sha256").update(JSON.stringify({ operation: `subject.${operation}`, ...input })).digest("hex");
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const prior = database.prepare(`SELECT request_hash, result_payload FROM context_commands
      WHERE workspace_id = ? AND idempotency_key = ?`).get(input.workspaceId, input.commandId) as
      { request_hash: string; result_payload: string } | undefined;
    if (prior) {
      if (prior.request_hash !== requestHash) throw new ContextSubjectError("Idempotency key was reused", 409, "idempotency_conflict");
      database.exec("COMMIT");
      return { ...JSON.parse(prior.result_payload), replayed: true } as { subject: StandaloneSubject; replayed: boolean };
    }
    const beforeRow = rowFor(input.id, input.workspaceId);
    const before = beforeRow ? deserialize(beforeRow) : null;
    if (operation === "create") {
      if (input.expectedRevision !== 0) throw new ContextSubjectError("New subjects require revision 0", 409, "revision_conflict");
      if (database.prepare("SELECT id FROM context_subjects WHERE id = ?").get(input.id)) throw new ContextSubjectError("Subject ID already exists", 409, "subject_exists");
    } else {
      if (!before) throw new ContextSubjectError("Person or organization not found", 404, "not_found");
      if (before.revision !== input.expectedRevision) throw new ContextSubjectError("Subject changed on another device", 409, "revision_conflict");
      if (before.archivedAt) throw new ContextSubjectError("Subject is archived", 409, "archived");
    }
    if (title && (operation === "create" || before?.title !== title)) {
      const candidates = database.prepare(`SELECT id, display_title FROM context_subjects WHERE workspace_id = ?
        AND subject_type = ? AND canonical_entity_id IS NULL AND archived_at IS NULL`)
        .all(input.workspaceId, operation === "create" ? input.type! : before!.type) as
        Array<{ id: string; display_title: string }>;
      const duplicates = candidates.filter((candidate) => candidate.id !== input.id && normalizeTitle(candidate.display_title) === normalizeTitle(title));
      if (duplicates.length) throw new ContextSubjectError("A person or organization with this name already exists", 409, "duplicate_subject");
    }
    const now = Date.now();
    const changed = operation === "create" || operation === "archive" || before?.title !== title;
    if (operation === "create") {
      database.prepare(`INSERT INTO context_subjects
        (id, workspace_id, subject_type, canonical_entity_id, display_title, revision, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, NULL, ?, 1, ?, ?, NULL)`).run(input.id, input.workspaceId, input.type!, title!, now, now);
    } else if (changed && operation === "rename") {
      database.prepare(`UPDATE context_subjects SET display_title = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND revision = ?`).run(title!, now, input.id, input.workspaceId, input.expectedRevision);
    } else if (changed) {
      database.prepare(`UPDATE context_subjects SET archived_at = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND revision = ?`).run(now, now, input.id, input.workspaceId, input.expectedRevision);
    }
    const subject = deserialize(rowFor(input.id, input.workspaceId)!);
    if (changed) {
      database.prepare(`INSERT INTO context_change_events
        (id, command_id, workspace_id, actor, object_id, operation, before_revision, after_revision,
         before_payload, after_payload, created_at) VALUES (?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?, ?)`).run(
          randomUUID(), input.commandId, input.workspaceId, input.id, `subject.${operation}`, before?.revision ?? null,
          subject.revision, before ? JSON.stringify(before) : null, JSON.stringify(subject), now);
    }
    const result = { subject, replayed: false };
    database.prepare(`INSERT INTO context_commands
      (workspace_id, idempotency_key, request_hash, result_payload, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.workspaceId, input.commandId, requestHash, JSON.stringify(result), now);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export const createStandaloneSubject = (input: SubjectCommand & { type: StandaloneSubjectType; title: string; expectedRevision: 0 }) => runCommand("create", input);
export const renameStandaloneSubject = (input: SubjectCommand & { title: string }) => runCommand("rename", input);
export const archiveStandaloneSubject = (input: SubjectCommand) => runCommand("archive", input);

export function listStandaloneSubjectHistory(workspaceId: string, id: string) {
  getStandaloneSubject(workspaceId, id);
  const rows = getDatabase().prepare(`SELECT operation, before_revision AS beforeRevision, after_revision AS afterRevision,
    before_payload AS beforePayload, after_payload AS afterPayload, created_at AS createdAt
    FROM context_change_events WHERE workspace_id = ? AND object_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 100`).all(workspaceId, id) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    operation: String(row.operation),
    beforeRevision: row.beforeRevision == null ? null : Number(row.beforeRevision),
    afterRevision: Number(row.afterRevision),
    beforeTitle: row.beforePayload ? String((JSON.parse(String(row.beforePayload)) as { title?: string }).title || "") : null,
    afterTitle: row.afterPayload ? String((JSON.parse(String(row.afterPayload)) as { title?: string }).title || "") : null,
    createdAt: Number(row.createdAt),
  }));
}
