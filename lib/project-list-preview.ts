import type { Entity } from "./db";
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
