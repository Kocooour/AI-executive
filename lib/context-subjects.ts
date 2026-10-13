import { assertCommandWorkspace, contextIdPattern, ContextCommandError, requireChanged, runContextCommand, type CommandHooks } from "./context-commands";
import { getDatabase } from "./server-store";

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

export class ContextSubjectError extends ContextCommandError {}

type SubjectRow = {
  id: string; workspace_id: string; subject_type: string; canonical_entity_id: string | null;
  display_title: string; revision: number; archived_at: number | null; created_at: number; updated_at: number;
};
const idPattern = contextIdPattern;
const titlePattern = /\S/u;

const assertWorkspace = assertCommandWorkspace;

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

function assertNoDuplicateSubject(workspaceId: string, type: StandaloneSubjectType, id: string, title: string) {
  const candidates = getDatabase().prepare(`SELECT id, display_title FROM context_subjects WHERE workspace_id = ?
    AND subject_type = ? AND canonical_entity_id IS NULL AND archived_at IS NULL`).all(workspaceId, type) as
    Array<{ id: string; display_title: string }>;
  if (candidates.some((candidate) => candidate.id !== id && normalizeTitle(candidate.display_title) === normalizeTitle(title))) {
    throw new ContextSubjectError("A person or organization with this name already exists", 409, "duplicate_subject");
  }
}

type SubjectCommand = {
  commandId: string; workspaceId: string; id: string; expectedRevision: number;
  type?: StandaloneSubjectType; title?: string;
};

function runCommand(operation: "create" | "rename" | "archive", input: SubjectCommand, hooks?: CommandHooks) {
  if (!idPattern.test(input.commandId) || !idPattern.test(input.id)) throw new ContextSubjectError("Invalid command or subject identifier");
  if (operation === "create" && input.id.startsWith("canonical:")) {
    throw new ContextSubjectError("Subject identifier uses a reserved prefix", 400, "reserved_subject_id");
  }
  assertWorkspace(input.workspaceId);
  const title = operation === "archive" ? undefined : cleanTitle(String(input.title || ""));
  if (operation === "create" && input.type !== "person" && input.type !== "organization") throw new ContextSubjectError("Invalid subject type");
  const request = { commandId: input.commandId, workspaceId: input.workspaceId, id: input.id,
    expectedRevision: input.expectedRevision, ...(operation === "create" ? { type: input.type } : {}),
    ...(title === undefined ? {} : { title }) };
  return runContextCommand({
    operation: `subject.${operation}`, commandId: input.commandId, workspaceId: input.workspaceId, request, hooks,
    mutate: () => {
      const database = getDatabase();
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
      const changed = operation === "create" || operation === "archive" || before?.title !== title;
      // Only a real name change is checked against other names, so returning to an earlier name
      // (A -> B -> A) is not blocked by the earlier history of this very subject.
      if (title && changed) assertNoDuplicateSubject(input.workspaceId, operation === "create" ? input.type! : before!.type, input.id, title);
      const now = Date.now();
      if (operation === "create") {
        database.prepare(`INSERT INTO context_subjects
          (id, workspace_id, subject_type, canonical_entity_id, display_title, revision, created_at, updated_at, archived_at)
          VALUES (?, ?, ?, NULL, ?, 1, ?, ?, NULL)`).run(input.id, input.workspaceId, input.type!, title!, now, now);
      } else if (changed && operation === "rename") {
        requireChanged(database.prepare(`UPDATE context_subjects SET display_title = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND revision = ?`).run(title!, now, input.id, input.workspaceId, input.expectedRevision),
          "Subject changed on another device");
      } else if (changed) {
        requireChanged(database.prepare(`UPDATE context_subjects SET archived_at = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND revision = ?`).run(now, now, input.id, input.workspaceId, input.expectedRevision),
          "Subject changed on another device");
      }
      const subject = deserialize(rowFor(input.id, input.workspaceId)!);
      return { result: { subject }, objectId: input.id, operation: `subject.${operation}`, changed,
        before: before ? { revision: before.revision, payload: before } : null,
        after: { revision: subject.revision, payload: subject } };
    },
  });
}

export const createStandaloneSubject = (input: SubjectCommand & { type: StandaloneSubjectType; title: string; expectedRevision: 0 }, hooks?: CommandHooks) => runCommand("create", input, hooks);
export const renameStandaloneSubject = (input: SubjectCommand & { title: string }, hooks?: CommandHooks) => runCommand("rename", input, hooks);
export const archiveStandaloneSubject = (input: SubjectCommand, hooks?: CommandHooks) => runCommand("archive", input, hooks);

export function listStandaloneSubjectHistory(workspaceId: string, id: string) {
  getStandaloneSubject(workspaceId, id);
  const rows = getDatabase().prepare(`SELECT operation, kind, before_revision AS beforeRevision, after_revision AS afterRevision,
    before_payload AS beforePayload, after_payload AS afterPayload, created_at AS createdAt
    FROM context_change_events WHERE workspace_id = ? AND object_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 100`).all(workspaceId, id) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    operation: String(row.operation),
    kind: String(row.kind || "change"),
    beforeRevision: row.beforeRevision == null ? null : Number(row.beforeRevision),
    afterRevision: Number(row.afterRevision),
    beforeTitle: row.beforePayload ? String((JSON.parse(String(row.beforePayload)) as { title?: string }).title || "") : null,
    afterTitle: row.afterPayload ? String((JSON.parse(String(row.afterPayload)) as { title?: string }).title || "") : null,
    createdAt: Number(row.createdAt),
  }));
}

/**
 * Undo/Redo of one person/organization step, as a new revision (see compensateClaim in context-claims).
 * `after` is the state the reversed step left the subject in, `before` the state it started from; a step
 * that created the subject is reversed by archiving it. Must run inside a context command.
 */
export function compensateSubject(input: { workspaceId: string; id: string; expectedRevision: number;
  before: StandaloneSubject | null; after: StandaloneSubject }) {
  const row = rowFor(input.id, input.workspaceId);
  if (!row) throw new ContextSubjectError("The person or organization no longer exists", 409, "undo_conflict");
  const current = deserialize(row);
  if (current.revision !== input.expectedRevision || current.title !== input.after.title ||
    (current.archivedAt != null) !== (input.after.archivedAt != null)) {
    throw new ContextSubjectError("The person or organization was changed after this step", 409, "undo_conflict");
  }
  const title = (input.before ?? input.after).title;
  const archived = input.before ? input.before.archivedAt != null : true;
  if (!archived) assertNoDuplicateSubject(input.workspaceId, current.type, input.id, title);
  const now = Date.now();
  requireChanged(getDatabase().prepare(`UPDATE context_subjects SET display_title = ?, archived_at = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND revision = ?`).run(title, archived ? (current.archivedAt ?? now) : null, now,
    input.id, input.workspaceId, input.expectedRevision), "Subject changed on another device");
  return { subject: deserialize(rowFor(input.id, input.workspaceId)!), before: current };
}
