import type { ReactNode } from "react";

// A visual-only mapping: never changes where writes go or the workspace's stored metadata.
// The data model currently distinguishes personal/shared, not work/family subtypes.
// Named family workspaces use the family palette; other shared workspaces use work.
export type WorkspaceTone = "personal" | "work" | "family" | "all";

export function workspaceTone(id: string, title: string, kind?: unknown): WorkspaceTone {
  if (id === "all") return "all";
  if (id === "personal" || kind === "personal") return "personal";
  if (/^(rodina|rodinn[ýy]|family|familie)(?:\b|\s|$)/i.test(title.trim())) return "family";
  return "work";
}

export function WorkspaceTile({ tone, label }: { tone: WorkspaceTone; label: string }): ReactNode {
  const initial = tone === "all" ? "∗" : (Array.from(label.trim())[0]?.toLocaleUpperCase() || "•");
  return <span className="workspaceTile" data-tone={tone} aria-hidden="true">{initial}</span>;
}
