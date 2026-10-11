import assert from "node:assert/strict";
import test from "node:test";

const { dropNotesDraft, keepNotesDraft, keptNotesDrafts, leftoverDraftAction, notesDraftsKey, settleNotesDraft } = await import("../lib/notes-drafts.ts");

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    key: (index) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
}

test("each page keeps its own draft per task", () => {
  const storage = memoryStorage();
  keepNotesDraft(storage, "tab-a", "task-1", "A", "", 1);
  keepNotesDraft(storage, "tab-b", "task-2", "B", "", 2);
  keepNotesDraft(storage, "tab-b", "task-1", "B1", "", 3);
  assert.deepEqual(keptNotesDrafts(storage).map((draft) => `${draft.page}:${draft.id}=${draft.text}`).sort(),
    ["tab-a:task-1=A", "tab-b:task-1=B1", "tab-b:task-2=B"]);
});

test("a draft keeps the notes it started from until it is saved", () => {
  const storage = memoryStorage();
  keepNotesDraft(storage, "tab", "task", "a", "old", 1);
  keepNotesDraft(storage, "tab", "task", "ab", "a", 2);
  assert.equal(keptNotesDrafts(storage)[0].base, "old");
  assert.equal(keptNotesDrafts(storage)[0].at, 2);
});

test("a save removes the draft, or moves it forward when typing went on", () => {
  const storage = memoryStorage();
  keepNotesDraft(storage, "tab", "task", "abc", "", 1);
  settleNotesDraft(storage, "tab", "task", "ab");
  assert.equal(keptNotesDrafts(storage)[0].base, "ab");
  assert.equal(keptNotesDrafts(storage)[0].text, "abc");
  settleNotesDraft(storage, "tab", "task", "abc");
  assert.deepEqual(keptNotesDrafts(storage), []);
  assert.equal(storage.getItem(notesDraftsKey), null);
});

test("settling one page's draft leaves another page's draft for the same task", () => {
  const storage = memoryStorage();
  keepNotesDraft(storage, "tab-a", "task", "x", "", 1);
  keepNotesDraft(storage, "tab-b", "task", "y", "", 2);
  settleNotesDraft(storage, "tab-a", "task", "x");
  assert.deepEqual(keptNotesDrafts(storage).map((draft) => draft.page), ["tab-b"]);
});

test("dropping skips a draft that was typed into after it was looked at", () => {
  const storage = memoryStorage();
  keepNotesDraft(storage, "tab", "task", "a", "", 1);
  const seen = keptNotesDrafts(storage)[0];
  keepNotesDraft(storage, "tab", "task", "ab", "", 2);
  dropNotesDraft(storage, seen);
  assert.equal(keptNotesDrafts(storage)[0].text, "ab");
  dropNotesDraft(storage, keptNotesDrafts(storage)[0]);
  assert.deepEqual(keptNotesDrafts(storage), []);
});

test("a leftover draft is saved only over the notes it started from", () => {
  const draft = { id: "task", text: "new", base: "old", at: 1, page: "tab" };
  assert.equal(leftoverDraftAction(draft, "old"), "save");
  assert.equal(leftoverDraftAction(draft, "new"), "done");
  assert.equal(leftoverDraftAction(draft, "changed elsewhere"), "conflict");
  assert.equal(leftoverDraftAction(draft, undefined), "gone");
});

test("damaged or foreign content is ignored and storage errors do not throw", () => {
  const storage = memoryStorage();
  storage.setItem(notesDraftsKey, "{bad");
  assert.deepEqual(keptNotesDrafts(storage), []);
  storage.setItem(notesDraftsKey, JSON.stringify({ x: { id: 1 }, "t:a": { id: "a", text: "t", base: "", at: 1, page: "t" } }));
  assert.equal(keptNotesDrafts(storage).length, 1);
  const full = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("denied"); }, key: () => null, length: 0 };
  assert.doesNotThrow(() => keepNotesDraft(full, "tab", "task", "a", "", 1));
});

// Tabs write to the same storage independently: each page writes only its own keys, so a draft
// typed in one tab cannot be overwritten by another tab writing its own draft at the same moment.
test("each page's draft is a key of its own; older shared values are moved", () => {
  const storage = memoryStorage();
  storage.setItem(notesDraftsKey, JSON.stringify({ "old:a": { id: "a", text: "staré", base: "", at: 1, page: "old" } }));
  keepNotesDraft(storage, "tab-a", "x", "A", "", 2);
  keepNotesDraft(storage, "tab-b", "x", "B", "", 3);
  assert.deepEqual([...storage.data.keys()].sort(), [`${notesDraftsKey}:old:a`, `${notesDraftsKey}:tab-a:x`, `${notesDraftsKey}:tab-b:x`]);
  assert.deepEqual(keptNotesDrafts(storage).map((draft) => draft.text).sort(), ["A", "B", "staré"]);
  assert.equal(storage.getItem(notesDraftsKey), null);
});
