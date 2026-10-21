import type { Entity, Relation } from "./db";

export type SearchKind = "all" | "task" | "project" | "area" | "note";
export type SearchMatch = "title" | "content" | "related";
export interface SearchHit { entity: Entity; match: SearchMatch }

// Czech users should find "Zavolat" by "zavolat", and "Příprava" by "priprava".
// Searches are local, over records already authorized for the active workspace.
const normalized = (text: string) =>
  text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().trim();

export function searchWorkspaceItems(
  items: readonly Entity[], relations: readonly Relation[], query: string,
): SearchHit[] {
  const words = normalized(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const visible = new Map(items.filter(item => item.type !== "workspace").map(item => [item.id, item]));
  const links = new Map<string, string[]>();
  for (const relation of relations) {
    const a = visible.get(relation.sourceEntityId), b = visible.get(relation.targetEntityId);
    // Relations from another workspace, even if present in the local cache,
    // must never affect search results or disclose a connected title.
    if (!a || !b || a.workspaceId !== b.workspaceId || a.workspaceId !== relation.workspaceId) continue;
    links.set(a.id, [...(links.get(a.id) || []), b.title]);
    links.set(b.id, [...(links.get(b.id) || []), a.title]);
  }
  const hits: SearchHit[] = [];
  for (const entity of visible.values()) {
    const title = normalized(entity.title || "");
    const content = normalized(entity.content || "");
    const related = normalized((links.get(entity.id) || []).join(" "));
    const combined = `${title} ${content} ${related}`;
    if (!words.every(word => combined.includes(word))) continue;
    const match: SearchMatch = words.every(word => title.includes(word)) ? "title"
      : words.every(word => `${title} ${content}`.includes(word)) ? "content" : "related";
    hits.push({ entity, match });
  }
  // Titles first, then descriptions and related records; stable name sorting
  // keeps the list predictable while typing and switching type filters.
  const rank: Record<SearchMatch, number> = { title: 0, content: 1, related: 2 };
  return hits.sort((a, b) => rank[a.match] - rank[b.match] ||
    a.entity.title.localeCompare(b.entity.title, "cs") || a.entity.id.localeCompare(b.entity.id));
}
