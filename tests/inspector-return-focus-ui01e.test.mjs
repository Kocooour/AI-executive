import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  advanceInspectorReturnFocus,
  inspectorOpenerMatchesSelection,
  shouldRestoreInspectorFocus,
} from "../lib/inspector-return-focus.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const originA = { entityId: "task-a", workspaceId: "personal", view: "Today" };
const currentA = { workspaceId: "personal", view: "Today",
  rowEntityId: "task-a", connected: true, rendered: true };

// Structural DOM doubles: the exact lifecycle called by DetailPanel is executed
// here. Playwright covers React events and real DOM focus in the release gate.
function opener(entityId, focusEvents, options = {}) {
  let rowEntityId = entityId;
  let connected = true;
  let rendered = true;
  const row = { dataset: { get dropEntity() { return rowEntityId; } } };
  const button = {
    matches: (selector) => selector === ".taskRowOpen",
    closest: (selector) => selector === "[data-drop-entity]" ? row : null,
    focus: (options) => focusEvents.push({ id: entityId, options }),
    get isConnected() { return connected; },
    getClientRects: () => rendered ? [{}] : [],
    detach: () => { connected = false; },
    hide: () => { rendered = false; },
    rebound: (id) => { rowEntityId = id; },
  };
  if (options.missingRow) button.closest = () => null;
  return button;
}

test("UI-01e: an inspector opener must be a row of exactly the selected entity", () => {
  assert.equal(inspectorOpenerMatchesSelection("task-a", "task-a"), true);
  assert.equal(inspectorOpenerMatchesSelection("task-b", "task-a"), false);
  assert.equal(inspectorOpenerMatchesSelection("task-a", null), false);
});

test("UI-01e: Back/close returns focus only to a connected visible row in original scope", () => {
  assert.equal(shouldRestoreInspectorFocus(originA, currentA), true);
  assert.equal(shouldRestoreInspectorFocus(originA, { ...currentA, rowEntityId: "task-b" }), false);
  assert.equal(shouldRestoreInspectorFocus(originA, { ...currentA, workspaceId: "shared" }), false);
  assert.equal(shouldRestoreInspectorFocus(originA, { ...currentA, view: "Projects" }), false);
  assert.equal(shouldRestoreInspectorFocus(originA, { ...currentA, connected: false }), false);
  assert.equal(shouldRestoreInspectorFocus(originA, { ...currentA, rendered: false }), false);
  assert.equal(shouldRestoreInspectorFocus(null, currentA), false);
});

test("UI-01e: A keyboard open, close, pointer-select B, close B never refocuses A", () => {
  const events = [];
  const a = opener("task-a", events);
  const inspector = { focus: () => events.push({ id: "inspector" }) };
  let pending = advanceInspectorReturnFocus(null, "task-a", a, inspector, "personal", "Today");
  assert.deepEqual(events, [{ id: "inspector" }]);
  pending = advanceInspectorReturnFocus(pending, null, inspector, null, "personal", "Today");
  assert.equal(pending, null, "the first close must consume A's origin");
  assert.deepEqual(events.at(-1), { id: "task-a", options: { preventScroll: true } });
  // Clicking a non-focusable row leaves the previous opener in document.activeElement.
  pending = advanceInspectorReturnFocus(pending, "task-b", a, inspector, "personal", "Today");
  assert.equal(pending, null, "A's still-active button cannot become B's opener");
  pending = advanceInspectorReturnFocus(pending, null, inspector, null, "personal", "Today");
  assert.equal(pending, null);
  assert.deepEqual(events, [{ id: "inspector" }, { id: "task-a", options: { preventScroll: true } }]);
});

test("UI-01e: keyboard B takes ownership and gets exactly one return focus", () => {
  const events = [];
  const b = opener("task-b", events);
  const inspector = { focus: () => events.push({ id: "inspector" }) };
  let pending = advanceInspectorReturnFocus(null, "task-b", b, inspector, "personal", "Inbox");
  assert.equal(pending.origin.entityId, "task-b");
  pending = advanceInspectorReturnFocus(pending, null, inspector, null, "personal", "Inbox");
  pending = advanceInspectorReturnFocus(pending, null, null, null, "personal", "Inbox");
  assert.equal(pending, null);
  assert.deepEqual(events, [{ id: "inspector" }, { id: "task-b", options: { preventScroll: true } }]);
});

test("UI-01e: selection, view and workspace changes invalidate the pending opener", () => {
  for (const next of [
    { id: "task-b", workspace: "personal", view: "Today" },
    { id: "task-a", workspace: "shared", view: "Today" },
    { id: "task-a", workspace: "personal", view: "Projects" },
  ]) {
    const events = [];
    const a = opener("task-a", events);
    const inspector = { focus: () => events.push({ id: "inspector" }) };
    let pending = advanceInspectorReturnFocus(null, "task-a", a, inspector, "personal", "Today");
    pending = advanceInspectorReturnFocus(pending, next.id, inspector, inspector, next.workspace, next.view);
    assert.equal(pending, null, "no matching active row in new selection/scope");
    pending = advanceInspectorReturnFocus(pending, null, null, null, next.workspace, next.view);
    assert.equal(pending, null);
    assert.deepEqual(events, [{ id: "inspector" }]);
  }
});

test("UI-01e: detached, hidden, reused or absent rows fail closed", () => {
  for (const invalidate of [
    (a) => a.detach(), (a) => a.hide(), (a) => a.rebound("task-b"),
  ]) {
    const events = [];
    const a = opener("task-a", events);
    const inspector = { focus: () => events.push({ id: "inspector" }) };
    let pending = advanceInspectorReturnFocus(null, "task-a", a, inspector, "personal", "Today");
    invalidate(a);
    pending = advanceInspectorReturnFocus(pending, null, null, null, "personal", "Today");
    assert.equal(pending, null);
    assert.deepEqual(events, [{ id: "inspector" }]);
  }
  const events = [];
  const missing = opener("task-a", events, { missingRow: true });
  assert.equal(advanceInspectorReturnFocus(null, "task-a", missing, null, "personal", "Today"), null);
  assert.equal(advanceInspectorReturnFocus(null, "task-a", null, null, "personal", "Today"), null,
    "direct URL has no opener");
});

test("UI-01e: matching row metadata is used and no new navigation authority is introduced", () => {
  const rows = read("../app/ui/views/entity-list.tsx");
  assert.match(rows, /data-drop-entity=\{x\.id\}/);
  assert.match(rows, /className="taskRowOpen"/);
  const helper = read("../lib/inspector-return-focus.ts");
  assert.doesNotMatch(helper, /history\.|localStorage|sessionStorage|fetch\(|setSelected|db\./);
  const panel = read("../app/ui/views/detail-panel.tsx");
  assert.match(panel, /if \(!mobileDesignV1Preview\) return;/,
    "existing preview-only Escape behavior and keyboard affordance are unchanged");
  assert.match(panel, /advanceInspectorReturnFocus\(/,
    "DetailPanel must actually use the lifecycle tested above");
});
