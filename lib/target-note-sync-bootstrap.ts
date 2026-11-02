/**
 * R2d.2c.2g.1 — isolated note-sync bootstrap manifest (internal read model).
 *
 * List ONLY metadata of current notes in ONE currently readable Area. A caller
 * must use a preflighted, pinned read-only staging snapshot and a verified
 * server identity; no request-provided identity is trusted here. This function
 * is NOT an HTTP endpoint or a live-release/session guard. Before an HTTP
 * response, recheck the live session, Area policy and note/parent guards.
 *
 * A complete manifest can reconcile missing local IDs after a full refresh;
 * it is NOT an incremental change feed. In particular, absence is not a
 * tombstone and raw afterId must never be accepted as an HTTP cursor.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { TargetReadAreaAccess, TargetReadLinearization } from "./target-task-read-model";

const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
const MAX_NOTE_ID_BYTES = 512;
const MAX_NOTES = 4096;
const REVISION = /^[a-f0-9]{64}$/;
const RESTORE_GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const NOTE_BOOTSTRAP_PAGE_LIMIT = 100;

function validId(value: unknown): value is string {
  return typeof value === "string" && value !== "" &&
    value.trim() === value && value !== "." && value !== ".." &&
    Buffer.byteLength(value, "utf8") <= MAX_NOTE_ID_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export type NoteBootstrapEntry = {
  id: string;
  revision: number;
  projectId: string | null;
  parentRevision: number | null;
};

export type TargetNoteBootstrapPage = {
  entries: NoteBootstrapEntry[];
  /** Stable for every page of the same Area+actor snapshot. */
  snapshotRevision: string;
  hasMore: boolean;
  /** Internal keyset marker, NOT a signed cursor or HTTP capability. */
  nextAfterId: string | null;
  /** Internal authorization witness. Must be rechecked before release. */
  linearization: TargetReadLinearization;
};

type AreaRow = {
  areaKind: string;
  workspaceKind: string;
  areaOwner: string;
  workspaceOwner: string;
  policyRevision: number;
  memberRole: string | null;
};
type NoteRow = NoteBootstrapEntry & { directAreaId: string | null; projectAreaId: string | null };

/**
 * Does not expose note title/body, foreign IDs, counts or tombstones.
 * Returns null for an unknown/unreadable Area, malformed state or SQL failure.
 * The full bounded Area manifest is hashed before keyset pagination so a
 * caller can reject page sequences whose snapshot revision changed.
 */
export function readAuthorizedTargetNoteBootstrapPage(
  db: DatabaseSync,
  request: { actorUserId: string; areaId: string; afterId: string | null;
    limit: number; expectedSnapshotRevision?: string },
): TargetNoteBootstrapPage | null {
  if (!request || typeof request.actorUserId !== "string" ||
      !ACTOR.test(request.actorUserId) || !validId(request.areaId) ||
      (request.afterId !== null && (!validId(request.afterId) ||
        typeof request.expectedSnapshotRevision !== "string" ||
        !REVISION.test(request.expectedSnapshotRevision))) ||
      (request.afterId === null && request.expectedSnapshotRevision !== undefined) ||
      !Number.isInteger(request.limit) || request.limit < 1 ||
      request.limit > NOTE_BOOTSTRAP_PAGE_LIMIT) return null;
  try {
    const area = db.prepare(`SELECT a.kind AS areaKind, w.kind AS workspaceKind,
        a.owner_user_id AS areaOwner, w.owner_user_id AS workspaceOwner,
        a.policy_revision AS policyRevision, m.role AS memberRole
      FROM areas a
      JOIN workspaces w ON w.id = a.workspace_id
      JOIN identities actor ON actor.id = ?
      LEFT JOIN area_members m ON m.area_id = a.id AND m.user_id = actor.id
      WHERE a.id = ? LIMIT 1`).get(request.actorUserId, request.areaId) as AreaRow | undefined;
    if (!area || typeof area.areaOwner !== "string" ||
        !ACTOR.test(area.areaOwner) || area.areaOwner !== area.workspaceOwner ||
        !Number.isSafeInteger(area.policyRevision) || area.policyRevision < 0) return null;
    let access: TargetReadAreaAccess;
    if (area.areaKind === "private" && area.workspaceKind === "personal" &&
        area.areaOwner === request.actorUserId) {
      access = "private-owner";
    } else if (area.areaKind === "shared" && area.workspaceKind === "shared" &&
        (area.memberRole === "viewer" || area.memberRole === "editor" || area.memberRole === "admin")) {
      access = area.memberRole;
    } else return null;

    // One bounded manifest; SELECT-only, scoped to the current Area, with
    // project parentage resolved server-side. No linked project grants access.
    const rows = db.prepare(`SELECT n.id AS id, n.revision AS revision,
        n.project_id AS projectId, p.revision AS parentRevision,
        n.area_id AS directAreaId, p.area_id AS projectAreaId
      FROM notes n
      LEFT JOIN projects p ON p.id = n.project_id
      WHERE (n.project_id IS NULL AND n.area_id = ?)
         OR (n.project_id IS NOT NULL AND n.area_id IS NULL AND p.area_id = ?)
      ORDER BY n.id COLLATE BINARY
      LIMIT ?`).all(request.areaId, request.areaId, MAX_NOTES + 1) as NoteRow[];
    if (rows.length > MAX_NOTES) return null;

    // The generation is read from the very same pinned, preflighted snapshot
    // as the Area and note rows; an old page may not survive a store restore.
    const generation = (db.prepare("SELECT value FROM metadata WHERE key='restore_generation'")
      .get() as { value: unknown } | undefined)?.value;
    if (typeof generation !== "string" || !RESTORE_GENERATION.test(generation)) return null;
    const digest = createHash("sha256");
    digest.update(JSON.stringify([
      "note-bootstrap-v2", generation.toLowerCase(), request.actorUserId, request.areaId,
      area.areaKind, access, area.policyRevision,
    ]) + "\n");
    const entries: NoteBootstrapEntry[] = [];
    let previous: Buffer | null = null;
    for (const row of rows) {
      const idBytes = Buffer.from(row.id ?? "", "utf8");
      if (!validId(row.id) || (previous && Buffer.compare(previous, idBytes) >= 0) ||
          !Number.isSafeInteger(row.revision) || row.revision < 0 ||
          (row.projectId === null
            ? row.directAreaId !== request.areaId || row.parentRevision !== null
            : !validId(row.projectId) || row.directAreaId !== null ||
              row.projectAreaId !== request.areaId ||
              !Number.isSafeInteger(row.parentRevision) || (row.parentRevision as number) < 0))
        return null;
      previous = idBytes;
      const entry: NoteBootstrapEntry = {
        id: row.id, revision: row.revision,
        projectId: row.projectId, parentRevision: row.parentRevision,
      };
      digest.update(JSON.stringify([entry.id, entry.revision, entry.projectId, entry.parentRevision]) + "\n");
      if (request.afterId === null ||
          Buffer.compare(idBytes, Buffer.from(request.afterId, "utf8")) > 0) entries.push(entry);
    }
    const page = entries.slice(0, request.limit);
    const hasMore = entries.length > page.length;
    const snapshotRevision = digest.digest("hex");
    if (request.expectedSnapshotRevision !== undefined &&
        request.expectedSnapshotRevision !== snapshotRevision) return null;
    return {
      entries: page,
      snapshotRevision,
      hasMore,
      nextAfterId: hasMore ? page[page.length - 1].id : null,
      linearization: {
        actorUserId: request.actorUserId,
        areas: [{
          areaId: request.areaId,
          areaKind: area.areaKind as "private" | "shared",
          policyRevision: area.policyRevision,
          access,
        }],
      },
    };
  } catch {
    // Uniform failure; do not leak the identity, Area, notes or SQL errors.
    return null;
  }
}
