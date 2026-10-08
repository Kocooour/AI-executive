// Notes being typed are kept in the device on every key press (localStorage is written
// synchronously, so the text survives the page being closed or killed before it was saved).
// Each page keeps its own drafts, one per task, so two tabs never overwrite each other's draft.
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
}

type Drafts = Record<string, KeptNotesDraft>;
const entryKey = (page: string, id: string) => `${page}:${id}`;

function isDraft(value: unknown): value is KeptNotesDraft {
  const draft = value as KeptNotesDraft;
  return Boolean(draft) && typeof draft.id === "string" && typeof draft.text === "string"
    && typeof draft.base === "string" && typeof draft.at === "number" && typeof draft.page === "string";
}

function read(storage: DraftStorage): Drafts {
  try {
    const parsed = JSON.parse(storage.getItem(notesDraftsKey) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, draft]) => isDraft(draft))) as Drafts;
  } catch {
    return {};
  }
}

function write(storage: DraftStorage, drafts: Drafts) {
  try {
    if (Object.keys(drafts).length) storage.setItem(notesDraftsKey, JSON.stringify(drafts));
    else storage.removeItem(notesDraftsKey);
  } catch {
    // Storage full or unavailable: the draft stays only in the page.
  }
}

export function keptNotesDrafts(storage: DraftStorage): KeptNotesDraft[] {
  return Object.values(read(storage));
}

// A key press. The draft keeps the notes it started from until it is saved.
export function keepNotesDraft(storage: DraftStorage, page: string, id: string, text: string, base: string, now = Date.now()) {
  const drafts = read(storage);
  const kept = drafts[entryKey(page, id)];
  drafts[entryKey(page, id)] = { id, text, base: kept ? kept.base : base, at: now, page };
  write(storage, drafts);
}

// After `saved` was saved for the task: the draft is gone if nothing was typed since; if typing
// went on during the save, the draft now starts from what was saved.
export function settleNotesDraft(storage: DraftStorage, page: string, id: string, saved: string) {
  const drafts = read(storage);
  const kept = drafts[entryKey(page, id)];
  if (!kept) return;
  if (kept.text === saved) delete drafts[entryKey(page, id)];
  else drafts[entryKey(page, id)] = { ...kept, base: saved };
  write(storage, drafts);
}

// Drops a draft, but only the version that was looked at (a newer key press keeps it).
export function dropNotesDraft(storage: DraftStorage, draft: KeptNotesDraft) {
  const drafts = read(storage);
  const kept = drafts[entryKey(draft.page, draft.id)];
  if (!kept || kept.at !== draft.at) return;
  delete drafts[entryKey(draft.page, draft.id)];
  write(storage, drafts);
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
