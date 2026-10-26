/**
 * Staging-only R1 → R2 policy foundation for the isolated target schema.
 *
 * The actor ID is supplied by the caller and is SYNTHETIC here: it is not an
 * authenticated session or token claim. Do not connect this helper to routes,
 * startup, sync, AI tools or a production store before R2 binds that identity,
 * revisions and per-item commands. These functions only SELECT from a supplied
 * DatabaseSync; they never mutate or return item content/member lists.
 */
import { DatabaseSync } from "node:sqlite";

export type TargetAreaPermission = "read" | "write" | "admin";
export type TargetPolicyReason =
  | "allowed" | "invalid_request" | "unknown_actor" | "area_unavailable"
  | "project_unavailable" | "project_area_mismatch"
  | "assignee_unavailable" | "query_failed";

export type TargetPolicyDecision =
  | { allowed: true; reason: "allowed"; effectiveAreaId: string }
  | { allowed: false; reason: Exclude<TargetPolicyReason, "allowed">; effectiveAreaId: null };

export interface TargetAreaPolicyRequest {
  actorUserId: string;
  areaId: string;
  permission: TargetAreaPermission;
}

export type TargetCreateRequest =
  | { kind: "create_project"; actorUserId: string; writeAreaId: string }
  | { kind: "create_standalone_task"; actorUserId: string; writeAreaId: string; assigneeUserId?: string | null }
  | { kind: "create_project_task"; actorUserId: string; writeAreaId: string;
      projectId: string; assigneeUserId?: string | null };

const deny = (reason: Exclude<TargetPolicyReason, "allowed">): TargetPolicyDecision =>
  ({ allowed: false, reason, effectiveAreaId: null });

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validAreaId(value: unknown): value is string {
  return validId(value) && value !== "all" && value !== "my-plan";
}

function actorExists(db: DatabaseSync, actorUserId: string): boolean {
  return db.prepare("SELECT 1 FROM identities WHERE id = ?").get(actorUserId) !== undefined;
}

type AreaRow = { kind: string; owner_user_id: string; workspace_kind: string;
  workspace_owner: string; role: string | null };

/** Authorization for one concrete Area, never an aggregate read scope. */
export function evaluateTargetAreaPolicy(
  db: DatabaseSync, request: TargetAreaPolicyRequest,
): TargetPolicyDecision {
  if (!request || !validId(request.actorUserId) || !validAreaId(request.areaId) ||
      !["read", "write", "admin"].includes(request.permission)) return deny("invalid_request");
  try {
    if (!actorExists(db, request.actorUserId)) return deny("unknown_actor");
    const row = db.prepare(`SELECT a.kind, a.owner_user_id, w.kind AS workspace_kind,
        w.owner_user_id AS workspace_owner, m.role
      FROM areas a JOIN workspaces w ON w.id = a.workspace_id
      LEFT JOIN area_members m ON m.area_id = a.id AND m.user_id = ?
      WHERE a.id = ?`).get(request.actorUserId, request.areaId) as AreaRow | undefined;
    // A broken boundary is not usable even if a membership row happens to exist.
    if (!row || row.owner_user_id !== row.workspace_owner ||
        (row.kind === "private" && row.workspace_kind !== "personal") ||
        (row.kind === "shared" && row.workspace_kind !== "shared") ||
        !["private", "shared"].includes(row.kind)) return deny("area_unavailable");
    if (row.kind === "private") {
      if (row.owner_user_id !== request.actorUserId) return deny("area_unavailable");
      return { allowed: true, reason: "allowed", effectiveAreaId: request.areaId };
    }
    if (!["viewer", "editor", "admin"].includes(row.role ?? "")) return deny("area_unavailable");
    // Same reason for absent membership, insufficient role and private cross-owner.
    if (request.permission === "admin" && row.role !== "admin") return deny("area_unavailable");
    if (request.permission === "write" && row.role === "viewer") return deny("area_unavailable");
    return { allowed: true, reason: "allowed", effectiveAreaId: request.areaId };
  } catch {
    return deny("query_failed");
  }
}

/**
 * Resolve a create intent to exactly one explicitly selected, writable Area.
 * Project tasks inherit the project's Area; a supplied different Area is
 * rejected, never treated as an instruction to move or publish the project.
 */
export function resolveTargetCreateArea(
  db: DatabaseSync, request: TargetCreateRequest,
): TargetPolicyDecision {
  if (!request || !["create_project", "create_standalone_task", "create_project_task"].includes(request.kind) ||
      !validId(request.actorUserId) || !validAreaId(request.writeAreaId) ||
      (request.kind === "create_project_task" && !validId(request.projectId)) ||
      (request.kind !== "create_project" && request.assigneeUserId != null &&
        !validId(request.assigneeUserId))) return deny("invalid_request");
  const selected = evaluateTargetAreaPolicy(db, {
    actorUserId: request.actorUserId, areaId: request.writeAreaId, permission: "write",
  });
  if (!selected.allowed) return selected;
  try {
    if (request.kind === "create_project_task") {
      const project = db.prepare("SELECT area_id FROM projects WHERE id = ?")
        .get(request.projectId) as { area_id: string } | undefined;
      if (!project || !validAreaId(project.area_id)) return deny("project_unavailable");
      // Do not disclose whether a project exists in an Area the actor cannot read.
      const projectRead = evaluateTargetAreaPolicy(db, {
        actorUserId: request.actorUserId, areaId: project.area_id, permission: "read",
      });
      if (!projectRead.allowed) return deny("project_unavailable");
      if (project.area_id !== request.writeAreaId) return deny("project_area_mismatch");
    }
    if (request.kind !== "create_project" && request.assigneeUserId != null) {
      const area = db.prepare("SELECT kind, owner_user_id FROM areas WHERE id = ?")
        .get(request.writeAreaId) as { kind: string; owner_user_id: string } | undefined;
      if (!area) return deny("area_unavailable");
      if (area.kind === "private") {
        // R1 schema permits no explicit assignee on a private task.
        return deny("assignee_unavailable");
      } else if (area.kind === "shared") {
        const member = db.prepare(`SELECT 1 FROM area_members
          WHERE area_id = ? AND user_id = ? AND role IN ('editor','admin')`)
          .get(request.writeAreaId, request.assigneeUserId);
        if (!member) return deny("assignee_unavailable");
      } else return deny("area_unavailable");
    }
    return selected;
  } catch {
    return deny("query_failed");
  }
}
