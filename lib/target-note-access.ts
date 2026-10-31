/**
 * R2d.2a: isolated target-model note ACL read foundation.
 *
 * Notes are NOT in the current staging schema yet. This selector is deliberately
 * not wired to HTTP, synchronization, search, AI, or the production store. Its
 * SQL describes the future canonical notes table and is exercised against a
 * synthetic schema in tests. Later integration MUST add a preflighted/pinned
 * snapshot and a live post-read identity + note/parent Area check before release.
 *
 * A direct project note inherits ONLY its project's Area; a standalone note
 * belongs to exactly one Area. A backlink, mention or other reference to a
 * project is not parentage and never grants access to the linked content.
 */
import { DatabaseSync } from "node:sqlite";
import type { TargetReadLinearization, TargetReadAreaAccess } from "./target-task-read-model";

const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
const MAX_NOTE_BYTES = 128 * 1024;
const MAX_NOTE_ID_BYTES = 512;

export type TargetReadableNote = {
  id: string;
  title: string;
  body: string;
  projectId: string | null;
  areaId: string;
  areaKind: "private" | "shared";
  revision: number;
};

export type TargetAuthorizedNote = {
  note: TargetReadableNote;
  /** The eventual HTTP gateway must revalidate this and the exact note parent. */
  linearization: TargetReadLinearization;
  /** Captures the ACL-parent identity for a live guard; not an HTTP field. */
  guard: { noteId: string; projectId: string | null; areaId: string;
    noteRevision: number; parentRevision: number | null };
};

type NoteRow = TargetReadableNote & {
  policyRevision: number;
  parentRevision: number | null;
  memberRole: string | null;
};

function validNoteId(id: unknown): id is string {
  return typeof id === "string" && id.trim() === id && id !== "" &&
    id !== "." && id !== ".." && Buffer.byteLength(id, "utf8") <= MAX_NOTE_ID_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(id);
}

/**
 * Exact-ID, actor-scoped query. Unauthorized, absent and structurally invalid
 * notes return the same null result; callers may not infer their existence.
 * Actor comes from the server, never a query/body-provided identity.
 */
export function readAuthorizedTargetNote(
  db: DatabaseSync, request: { actorUserId: string; noteId: string },
): TargetAuthorizedNote | null {
  if (!request || !ACTOR.test(request.actorUserId) || !validNoteId(request.noteId)) return null;
  try {
    const row = db.prepare(`SELECT
        n.id AS id, n.title AS title, n.body AS body,
        n.project_id AS projectId, a.id AS areaId, a.kind AS areaKind,
        n.revision AS revision, p.revision AS parentRevision,
        a.policy_revision AS policyRevision,
        member.role AS memberRole
      FROM notes n
      LEFT JOIN projects p ON p.id = n.project_id
      JOIN areas a ON a.id = COALESCE(n.area_id, p.area_id)
      JOIN workspaces w ON w.id = a.workspace_id
      JOIN identities actor ON actor.id = ?
      LEFT JOIN area_members member ON member.area_id = a.id AND member.user_id = actor.id
      WHERE n.id = ?
        AND ((n.project_id IS NULL AND n.area_id IS NOT NULL)
          OR (n.project_id IS NOT NULL AND n.area_id IS NULL AND p.id IS NOT NULL))
        AND a.owner_user_id = w.owner_user_id
        AND ((a.kind = 'private' AND w.kind = 'personal'
              AND a.owner_user_id = actor.id AND w.owner_user_id = actor.id)
          OR (a.kind = 'shared' AND w.kind = 'shared'
              AND member.role IN ('viewer', 'editor', 'admin')))
        AND length(CAST(n.body AS BLOB)) <= ? AND length(CAST(n.title AS BLOB)) <= ?
      LIMIT 1`).get(request.actorUserId, request.noteId, MAX_NOTE_BYTES, 4096) as
      NoteRow | undefined;
    if (!row || !validNoteId(row.id) || typeof row.title !== "string" ||
        row.title.trim() === "" || typeof row.body !== "string" ||
        Buffer.byteLength(row.body, "utf8") > MAX_NOTE_BYTES ||
        (row.projectId !== null && !validNoteId(row.projectId)) ||
        !validNoteId(row.areaId) ||
        (row.areaKind !== "private" && row.areaKind !== "shared") ||
        !Number.isSafeInteger(row.revision) || row.revision < 0 ||
        (row.projectId === null ? row.parentRevision !== null :
          !Number.isSafeInteger(row.parentRevision) || (row.parentRevision as number) < 0) ||
        !Number.isSafeInteger(row.policyRevision) || row.policyRevision < 0) return null;
    const access: TargetReadAreaAccess =
      row.areaKind === "private" ? "private-owner"
      : row.memberRole === "viewer" || row.memberRole === "editor" || row.memberRole === "admin"
        ? row.memberRole : "private-owner";
    // The SQL already checks shared membership; reject invalid/corrupt role
    // rather than falling back to a private-owner capability.
    if (row.areaKind === "shared" && access === "private-owner") return null;
    const note: TargetReadableNote = {
      id: row.id, title: row.title, body: row.body, projectId: row.projectId,
      areaId: row.areaId, areaKind: row.areaKind, revision: row.revision,
    };
    return {
      note,
      linearization: {
        actorUserId: request.actorUserId,
        areas: [{
          areaId: row.areaId, areaKind: row.areaKind,
          policyRevision: row.policyRevision, access,
        }],
      },
      guard: {
        noteId: row.id, projectId: row.projectId, areaId: row.areaId,
        noteRevision: row.revision, parentRevision: row.parentRevision,
      },
    };
  } catch {
    // No SQL exception details, data or foreign ID are exposed.
    return null;
  }
}
