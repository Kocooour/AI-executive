// Texts being typed in a tab that are not saved anywhere yet (an edited title, a new task in the
// capture dialog, a checklist item not added yet, text pasted for processing). Each tab keeps a
// note of what it has open in localStorage as it is typed, so that a tab signing out also knows
// about a tab that is asleep (for example a suspended Safari tab) and cannot answer: it then asks
// before anything is lost. Notes drafts have their own, fuller record (lib/notes-drafts.ts).

export const openTextsKey = "ai-executive-open-texts";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type OpenTextKind = "title" | "capture" | "checklist" | "contextInbox";
type Registry = Record<string, { kinds: OpenTextKind[]; at: number }>;

function read(storage: Store): Registry {
  try {
    const value = JSON.parse(storage.getItem(openTextsKey) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Registry : {};
  } catch {
    return {};
  }
}

export function setOpenTexts(storage: Store, page: string, kinds: OpenTextKind[]) {
  const registry = read(storage);
  const previous = registry[page]?.kinds || [];
  if (previous.length === kinds.length && previous.every((kind) => kinds.includes(kind))) return;
  if (kinds.length) registry[page] = { kinds, at: Date.now() };
  else delete registry[page];
  if (Object.keys(registry).length) storage.setItem(openTextsKey, JSON.stringify(registry));
  else storage.removeItem(openTextsKey);
}

// A note not renewed for this long is taken as left by a tab that is gone (closed by a crash, or
// killed by the system without notice). A tab renews its note whenever it is shown again.
export const openTextsMaxAgeMs = 24 * 60 * 60_000;

// Open texts of the other tabs of this browser.
export function otherOpenTexts(storage: Store, page: string, now = Date.now()) {
  return Object.entries(read(storage)).filter(([owner, entry]) => owner !== page && Array.isArray(entry?.kinds) && entry.kinds.length > 0 && now - Number(entry.at || 0) < openTextsMaxAgeMs);
}

// Renews this tab's note (it is still open) and removes notes that are too old.
export function renewOpenTexts(storage: Store, page: string, now = Date.now()) {
  const registry = read(storage);
  let changed = false;
  for (const [owner, entry] of Object.entries(registry)) {
    if (owner === page) { registry[owner] = { ...entry, at: now }; changed = true; }
    else if (!(now - Number(entry?.at || 0) < openTextsMaxAgeMs)) { delete registry[owner]; changed = true; }
  }
  if (!changed) return;
  if (Object.keys(registry).length) storage.setItem(openTextsKey, JSON.stringify(registry));
  else storage.removeItem(openTextsKey);
}
