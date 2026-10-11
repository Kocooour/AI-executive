// The last attention evaluation per workspace, kept in this browser so that Home can show it
// (marked out of date) when the server cannot be reached, also after the app was closed (owner
// decision 2026-10-09). It is a copy of server data: signing out removes it with the rest
// (lib/local-data.ts), and only the evaluation of the open workspace is ever shown.

export const attentionCacheKey = "ai-executive-attention";
// Workspaces kept; the oldest saved is dropped first. Items kept per workspace: enough to show
// and page through, without taking the storage other bookkeeping needs.
const maxWorkspaces = 8;
const maxItems = 50;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Cached<T> = { workspaceId: string; savedAt: number; evaluation: T };

function read<T>(storage: Store): Cached<T>[] {
  try {
    const parsed = JSON.parse(storage.getItem(attentionCacheKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.workspaceId === "string" && entry.evaluation && typeof entry.evaluation === "object") : [];
  } catch {
    return [];
  }
}

export function cachedAttention<T extends { workspaceId: string }>(storage: Store, workspaceId: string): T | null {
  const entry = read<T>(storage).find((candidate) => candidate.workspaceId === workspaceId);
  // Only an evaluation of exactly this workspace ("all" is its own entry).
  return entry && entry.evaluation.workspaceId === workspaceId ? entry.evaluation : null;
}

export function saveAttention<T extends { workspaceId: string; items?: unknown[] }>(storage: Store, evaluation: T, now = Date.now()) {
  const kept = Array.isArray(evaluation.items) && evaluation.items.length > maxItems ? { ...evaluation, items: evaluation.items.slice(0, maxItems) } : evaluation;
  const entries = [{ workspaceId: evaluation.workspaceId, savedAt: now, evaluation: kept },
    ...read<T>(storage).filter((entry) => entry.workspaceId !== evaluation.workspaceId)]
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, maxWorkspaces);
  try {
    storage.setItem(attentionCacheKey, JSON.stringify(entries));
  } catch {
    // Storage full or unavailable: keep only this workspace, or nothing.
    try { storage.setItem(attentionCacheKey, JSON.stringify(entries.slice(0, 1))); } catch { storage.removeItem(attentionCacheKey); }
  }
}
