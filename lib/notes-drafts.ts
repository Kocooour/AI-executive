import { isAdopting } from "./adoption";
import { offlineRecoveryIsHeld } from "./d2b-recovery-hold";
import { removeAllWithPrefix } from "./pending-markers";

// Notes being typed are kept in the device on every key press (localStorage is written
// synchronously, so the text survives the page being closed or killed before it was saved).
// Each page keeps its own drafts, one per task and key, so two tabs never overwrite each other's draft.
// Kept free of React and IndexedDB so it can be tested.

export const notesDraftsKey = "ai-executive-notes-drafts";

export interface KeptNotesDraft {
  id: string; // the task
  text: string;
  base: string; // the notes the draft started from
  at: number; // last key press
  page: string; // the page that typed it
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

// One key per page and task (`ai-executive-notes-drafts:<page>:<task>`), written only by that page:
// tabs write to localStorage independently, and a shared value read, changed and written back by
// two tabs at once would lose one tab's draft.
const draftKey = (page: string, id: string) => `${notesDraftsKey}:${page}:${id}`;

function isDraft(value: unknown): value is KeptNotesDraft {
  const draft = value as KeptNotesDraft;
  return Boolean(draft) && typeof draft.id === "string" && typeof draft.text === "string"
    && typeof draft.base === "string" && typeof draft.at === "number" && typeof draft.page === "string";
}

function parse(raw: string | null): unknown {
  try { return JSON.parse(raw || "null"); } catch { return null; }
}

function put(storage: DraftStorage, draft: KeptNotesDraft) {
  // Restored data is being adopted (lib/adoption.ts): a draft typed against the replaced data is not kept.
  if (isAdopting()) return;
  try {
    storage.setItem(draftKey(draft.page, draft.id), JSON.stringify(draft));
  } catch {
    // Storage full or unavailable: the draft stays only in the page.
  }
}

// Older versions kept all drafts in one value; they are moved to keys of their own.
function migrateLegacy(storage: DraftStorage) {
  if (offlineRecoveryIsHeld()) return;
  const raw = storage.getItem(notesDraftsKey);
  if (raw === null) return;
  const parsed = parse(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const draft of Object.values(parsed)) {
      if (!isDraft(draft)) continue;
      const present = get(storage, draft.page, draft.id);
      if (!present || present.at < draft.at) put(storage, draft);
    }
  }
  storage.removeItem(notesDraftsKey);
}

function keysOfDrafts(storage: DraftStorage) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key.startsWith(`${notesDraftsKey}:`)) keys.push(key);
  }
  return keys;
}

function get(storage: DraftStorage, page: string, id: string): KeptNotesDraft | null {
  const draft = parse(storage.getItem(draftKey(page, id)));
  return isDraft(draft) ? draft : null;
}

export function keptNotesDrafts(storage: DraftStorage): KeptNotesDraft[] {
  migrateLegacy(storage);
  return keysOfDrafts(storage).map((key) => parse(storage.getItem(key))).filter(isDraft);
}

// The drafts of one page (its notes were typed against data a restored backup replaced).
export function clearPageNotesDrafts(storage: DraftStorage, page: string) {
  if (offlineRecoveryIsHeld()) return;
  removeAllWithPrefix(storage, `${notesDraftsKey}:${page}:`);
}

// All drafts of this browser (signing out removes them).
export function clearNotesDrafts(storage: DraftStorage) {
  if (offlineRecoveryIsHeld()) return;
  removeAllWithPrefix(storage, `${notesDraftsKey}:`);
  storage.removeItem(notesDraftsKey);
}

// A key press. The draft keeps the notes it started from until it is saved.
export function keepNotesDraft(storage: DraftStorage, page: string, id: string, text: string, base: string, now = Date.now()) {
  migrateLegacy(storage);
  const kept = get(storage, page, id);
  put(storage, { id, text, base: kept ? kept.base : base, at: now, page });
}

// After `saved` was saved for the task: the draft is gone if nothing was typed since; if typing
// went on during the save, the draft now starts from what was saved.
export function settleNotesDraft(storage: DraftStorage, page: string, id: string, saved: string) {
  if (offlineRecoveryIsHeld()) return;
  const kept = get(storage, page, id);
  if (!kept) return;
  if (kept.text === saved) storage.removeItem(draftKey(page, id));
  else put(storage, { ...kept, base: saved });
}

// Drops a draft, but only the version that was looked at (a newer key press keeps it).
export function dropNotesDraft(storage: DraftStorage, draft: KeptNotesDraft) {
  if (offlineRecoveryIsHeld()) return;
  const kept = get(storage, draft.page, draft.id);
  if (!kept || kept.at !== draft.at) return;
  storage.removeItem(draftKey(draft.page, draft.id));
}

// What to do with a leftover draft, given the task's current notes (undefined: the task is gone).
// "save": the notes are still those the draft started from. "done": the notes already are the
// draft. "conflict": the notes were changed since the draft was started; the newer notes win.
export function leftoverDraftAction(draft: KeptNotesDraft, current: string | undefined): "save" | "done" | "conflict" | "gone" {
  if (current === undefined) return "gone";
  if (current === draft.text) return "done";
  if (current === draft.base) return "save";
  return "conflict";
}
