import { personalWorkspaceId } from "../../lib/db";

// A visual-only mapping: never changes where writes go or the workspace's stored metadata.
// The colour always comes from the fixed ws-* token set (docs/design-system/README.md), never a
// free colour, so the tile letter keeps its contrast. A tone stored on the workspace
// (properties.tone) wins; without one the personal workspace is personal, and a shared one is
// family when its title names a family, otherwise work. Whether the tone becomes a setting is an
// open product decision; until then the title is only the fallback.
export type WorkspaceTone = "personal" | "work" | "family" | "all";

interface WorkspaceLike {
  workspaceId: string;
  title: string;
  properties: Record<string, unknown>;
}

// "rodin…" covers every Czech form (rodina, rodinné, rodinný…); English and German need the whole
// word, so "Familiar Corp" stays work.
const familyWord = /(^|[^a-z])(rodin|family\b|familie\b)/;

export function workspaceTone(activeId: string, workspace?: WorkspaceLike): WorkspaceTone {
  if (activeId === "all") return "all";
  // An active workspace that is gone or not synced yet is shown with the personal name, so it
  // takes the personal colour too.
  if (!workspace || workspace.workspaceId === personalWorkspaceId || workspace.properties.kind === "personal") return "personal";
  const stored = workspace.properties.tone;
  if (stored === "work" || stored === "family") return stored;
  const title = workspace.title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return familyWord.test(title) ? "family" : "work";
}
