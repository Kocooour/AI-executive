// A project context is a whole owner statement; until it is committed the browser must keep
// a recoverable copy across navigation/reload, including a draft blocked by a remote edit.
// Keys are per tab, project and workspace, never sent to the server or embedded in URLs.
// All keys are purged by sign-out and restore adoption alongside notes drafts.
import { isAdopting } from "./adoption";
import { offlineRecoveryIsHeld } from "./d2b-recovery-hold";
import type { ProjectContext } from "./project-context";
import type { DraftStorage } from "./notes-drafts";

export const projectContextDraftPrefix = "ai-executive-project-context-drafts";
const tabKey = "ai-executive-project-context-tab";
const signedOutKey = "ai-executive-signed-out";

export type ProjectContextText = { why: string; goals: string[]; doneWhen: string };
export type KeptProjectContextDraft = {
  page: string; workspaceId: string; projectId: string;
  base: ProjectContext; baseGoal?: string | null; draft: ProjectContextText; at: number;
};

const keyOf = (page: string, workspaceId: string, projectId: string) =>
  projectContextDraftPrefix + ":" + encodeURIComponent(page) + ":" + encodeURIComponent(workspaceId) + ":" + encodeURIComponent(projectId);

const isText = (value: unknown): value is ProjectContextText => {
  if (!value || typeof value !== "object") return false;
  const text = value as ProjectContextText;
  return typeof text.why === "string" && text.why.length <= 10_000
    && typeof text.doneWhen === "string" && text.doneWhen.length <= 10_000
    && Array.isArray(text.goals) && text.goals.length <= 20
    && text.goals.every((goal) => typeof goal === "string" && goal.length <= 10_000);
};
const isContext = (value: unknown): value is ProjectContext => {
  if (!isText(value)) return false;
  const x = value as ProjectContext;
  return (x.provenance === "owner" || x.provenance === "lumi-approved")
    && (x.proposalId === undefined || typeof x.proposalId === "string")
    && typeof x.updatedAt === "number" && Number.isFinite(x.updatedAt);
};
function parse(value: string | null): KeptProjectContextDraft | null {
  if (!value || value.length > 50_000) return null;
  try {
    const item = JSON.parse(value) as KeptProjectContextDraft;
    return item && typeof item.page === "string" && typeof item.workspaceId === "string"
      && typeof item.projectId === "string" && Number.isFinite(item.at)
      && isContext(item.base) && (item.baseGoal === undefined || item.baseGoal === null || typeof item.baseGoal === "string")
      && isText(item.draft) ? item : null;
  } catch { return null; }
}
function keys(storage: DraftStorage) {
  const found: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(projectContextDraftPrefix + ":")) found.push(key);
    }
  } catch { /* Storage denied; keep in-memory editing available. */ }
  return found;
}
export function tabProjectContextDraftId(storage: Pick<DraftStorage, "getItem" | "setItem">): string {
  try {
    const existing = storage.getItem(tabKey);
    if (existing && /^[a-zA-Z0-9_-]{8,80}$/.test(existing)) return existing;
  } catch { /* Session storage may be disabled. */ }
  const fresh = "tab-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
  try { storage.setItem(tabKey, fresh); } catch { /* Fallback to the in-memory ID. */ }
  return fresh;
}

export function keptProjectContextDrafts(storage: DraftStorage) {
  const all: KeptProjectContextDraft[] = [];
  for (const key of keys(storage)) {
    let saved: KeptProjectContextDraft | null = null;
    try { saved = parse(storage.getItem(key)); } catch { /* ignore unreadable storage */ }
    if (saved && key === keyOf(saved.page, saved.workspaceId, saved.projectId)) all.push(saved);
  }
  return all;
}
export function recoverProjectContextDraft(storage: DraftStorage, page: string, workspaceId: string, projectId: string) {
  const candidates = keptProjectContextDrafts(storage).filter((item) =>
    item.workspaceId === workspaceId && item.projectId === projectId);
  return candidates.find((item) => item.page === page) ??
    candidates.sort((a, b) => b.at - a.at)[0] ?? null;
}

export function keepProjectContextDraft(storage: DraftStorage, entry: KeptProjectContextDraft): boolean {
  if (isAdopting()) return false;
  try {
    if (storage.getItem(signedOutKey) === "1") return false;
    storage.setItem(keyOf(entry.page, entry.workspaceId, entry.projectId), JSON.stringify(entry));
    return true;
  } catch { return false; }
}
export function dropProjectContextDraft(storage: DraftStorage, page: string, workspaceId: string, projectId: string) {
  if (offlineRecoveryIsHeld()) return;
  try { storage.removeItem(keyOf(page, workspaceId, projectId)); } catch { /* read-only browser storage */ }
}

// An in-flight save must not remove a newer draft typed while it was awaiting the server.
export function settleProjectContextDraft(storage: DraftStorage, page: string, workspaceId: string,
  projectId: string, saved: ProjectContextText, newBase: ProjectContext) {
  if (offlineRecoveryIsHeld()) return;
  const key = keyOf(page, workspaceId, projectId);
  let current: KeptProjectContextDraft | null = null;
  try { current = parse(storage.getItem(key)); } catch { /* unavailable */ }
  if (!current) return;
  if (JSON.stringify(current.draft) === JSON.stringify(saved)) {
    dropProjectContextDraft(storage, page, workspaceId, projectId);
  } else {
    // The in-flight save advanced both the context revision and its legacy mirror.
    // A newer draft must resume from that complete baseline after a reload.
    keepProjectContextDraft(storage, { ...current, base: newBase, baseGoal: newBase.doneWhen });
  }
}
export function clearProjectContextDrafts(storage: DraftStorage) {
  if (offlineRecoveryIsHeld()) return;
  for (const key of keys(storage)) {
    try { storage.removeItem(key); } catch { /* best effort, same as notes drafts */ }
  }
}
