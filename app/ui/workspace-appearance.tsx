import type { ReactNode } from "react";
import type { WorkspaceTone } from "./workspace-tone";

export { workspaceTone, type WorkspaceTone } from "./workspace-tone";

export function WorkspaceTile({ tone, label }: { tone: WorkspaceTone; label: string }): ReactNode {
  const initial = tone === "all" ? "∗" : (Array.from(label.trim())[0]?.toLocaleUpperCase() || "•");
  return <span className="workspaceTile" data-tone={tone} aria-hidden="true">{initial}</span>;
}
