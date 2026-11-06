import type { Entity, Relation } from "./db";
import type { ProjectSummary } from "./project-summary";

export type ProjectPreviewTone = "plain" | "warning" | "danger" | "complete";
export type ProjectAreaTone = "personal" | "work" | "family" | "extra-a" | "extra-b" | "extra-c" | "none";

/** Visual-only categorization; never use this palette to infer workspace or ACL. */
export function projectAreaPreviewTone(area: Pick<Entity, "id" | "title"> | null): ProjectAreaTone {
  if (!area) return "none";
  const name = area.title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (name === "osobni" || name === "personal") return "personal";
  if (name === "prace" || name === "work") return "work";
  if (name === "rodina" || name === "family") return "family";
  // Stable extra tones by area identity rather than array index: reordering
  // groups must not suddenly change their backgrounds.
  const hash = [...area.id].reduce((sum, ch) => ((sum * 31 + ch.charCodeAt(0)) >>> 0), 0);
  return (["extra-a", "extra-b", "extra-c"] as const)[hash % 3];
}

/** Legacy preview only: no cross-workspace quick writes or writes while a row is pending/held. */
export function projectPreviewCanToggle(
  project: Pick<Entity, "type" | "status" | "workspaceId">,
  activeWorkspaceId: string, blocked: boolean,
): boolean {
  return project.type === "project" && activeWorkspaceId === project.workspaceId &&
    (project.status === "active" || project.status === "completed") && !blocked;
}

/** Reject stale project confirmations at commit time, inside the local write transaction. */
export function projectPreviewCanCommit(
  expected: Entity, current: Entity | undefined, activeWorkspaceId: string, blocked: boolean,
): boolean {
  return !!current && current.id === expected.id && current.workspaceId === expected.workspaceId &&
    current.status === expected.status && current.updatedAt === expected.updatedAt &&
    projectPreviewCanToggle(current, activeWorkspaceId, blocked) &&
    JSON.stringify(current) === JSON.stringify(expected);
}

/** A confirmation covers the links and statuses that completion/deletion would affect. */
export function projectPreviewDependents(project: Entity, entities: Entity[], relations: Relation[]) {
  const links = relations.filter((relation) =>
    relation.sourceEntityId === project.id || relation.targetEntityId === project.id);
  const relationMembers = new Set(links.filter((relation) =>
    relation.relationType === "belongs_to_project" && relation.targetEntityId === project.id &&
    relation.workspaceId === project.workspaceId).map((relation) => relation.sourceEntityId));
  const members = entities.filter((entity) => entity.workspaceId === project.workspaceId &&
    (relationMembers.has(entity.id) ||
      ((entity.type === "task" || entity.type === "note") && entity.properties.projectId === project.id)))
    .map((entity) => ({ id: entity.id, type: entity.type, status: entity.status,
      workspaceId: entity.workspaceId,
      legacyProjectId: entity.properties.projectId === project.id ? project.id : null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    signature: JSON.stringify({
      links: links.map((relation) => [relation.id, relation.sourceEntityId, relation.targetEntityId,
        relation.workspaceId, relation.relationType, relation.createdAt])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      members,
    }),
    openTaskCount: members.filter((member) => member.type === "task" && member.status === "open" &&
      relationMembers.has(member.id)).length,
  };
}

export type ProjectPreviewActionSnapshot = { project: Entity; dependents: string; openTasks: number };

/** Wait for blur/autosaves registered before the action, including chained context saves. */
export async function waitForProjectPreviewWrites(pending: () => Promise<unknown>[]): Promise<void> {
  while (true) {
    const writes = pending();
    if (writes.length === 0) return;
    await Promise.all(writes);
  }
}

export function projectPreviewTone(project: Pick<Entity, "status">, summary: ProjectSummary): ProjectPreviewTone {
  if (project.status === "completed") return "complete";
  if (summary.projectOverdue || summary.attention?.kind === "overdue") return "danger";
  if (summary.attention?.kind === "noNext") return "warning";
  return "plain";
}

/** A single actionable or factual line; no counts, progress, or empty hints. */
export function projectPreviewSummary(project: Pick<Entity, "status">, summary: ProjectSummary, language: string): string | null {
  if (project.status === "completed") return null;
  const cs = language === "cs";
  if (summary.projectOverdue || summary.attention?.kind === "overdue") return cs ? "Po termínu" : "Overdue";
  if (summary.attention?.kind === "noNext") return cs ? "Chybí další krok" : "Next step needed";
  if (summary.next) return `${cs ? "Další krok" : "Next step"}: ${summary.next.title || (cs ? "Nepojmenovaný úkol" : "Untitled task")}`;
  return null;
}
