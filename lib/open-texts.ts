// Texts being typed in a tab that are not saved anywhere yet (an edited title, a new task in the
// capture dialog, a checklist item not added yet, text pasted for processing). Each tab keeps a
// note of what it has open in localStorage as it is typed, so that a tab signing out also knows
// about a tab that is asleep (for example a suspended Safari tab) and cannot answer: it then asks
// before anything is lost. Notes drafts have their own, fuller record (lib/notes-drafts.ts).

export const openTextsKey = "ai-executive-open-texts";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export type OpenTextKind = "title" | "capture" | "checklist" | "contextInbox";
type Entry = { kinds: OpenTextKind[]; at: number };

// One key per tab (`ai-executive-open-texts:<page>`), written only by that tab: tabs write to
// localStorage independently, and a shared value changed by two tabs at once would lose one note.
const pageKey = (page: string) => `${openTextsKey}:${page}`;

function parse(raw: string | null): Entry | null {
  try {
    const value = JSON.parse(raw || "null");
    return value && Array.isArray(value.kinds) ? value as Entry : null;
  } catch {
    return null;
  }
}

function all(storage: Store): Array<[string, Entry, string]> {
  const found: Array<[string, Entry, string]> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !key.startsWith(`${openTextsKey}:`)) continue;
    const raw = storage.getItem(key);
    const entry = parse(raw);
    if (entry && raw !== null) found.push([key.slice(openTextsKey.length + 1), entry, raw]);
  }
  return found;
}

export function setOpenTexts(storage: Store, page: string, kinds: OpenTextKind[]) {
  // A shared list kept by an older version is no longer read.
  if (storage.getItem(openTextsKey) !== null) storage.removeItem(openTextsKey);
  const previous = parse(storage.getItem(pageKey(page)))?.kinds || [];
  if (previous.length === kinds.length && previous.every((kind) => kinds.includes(kind))) return;
  if (kinds.length) storage.setItem(pageKey(page), JSON.stringify({ kinds, at: Date.now() }));
  else storage.removeItem(pageKey(page));
}

// A note not renewed for this long is taken as left by a tab that is gone (closed by a crash, or
// killed by the system without notice). A tab renews its note whenever it is shown again.
export const openTextsMaxAgeMs = 24 * 60 * 60_000;

// Open texts of the other tabs of this browser.
export function otherOpenTexts(storage: Store, page: string, now = Date.now()) {
  return all(storage).filter(([owner, entry]) => owner !== page && entry.kinds.length > 0 && now - Number(entry.at || 0) < openTextsMaxAgeMs)
    .map(([owner, entry]) => [owner, entry] as [string, Entry]);
}

// Renews this tab's note (it is still open) and removes notes that are too old.
export function renewOpenTexts(storage: Store, page: string, now = Date.now()) {
  for (const [owner, entry, raw] of all(storage)) {
    if (owner === page) storage.setItem(pageKey(page), JSON.stringify({ ...entry, at: now }));
    // Removed only if it is still the note that was found too old.
    else if (!(now - Number(entry.at || 0) < openTextsMaxAgeMs) && storage.getItem(pageKey(owner)) === raw) storage.removeItem(pageKey(owner));
  }
}

// All notes of this browser (signing out removes them).
export function clearOpenTexts(storage: Store) {
  for (const [owner] of all(storage)) storage.removeItem(pageKey(owner));
  storage.removeItem(openTextsKey);
}
