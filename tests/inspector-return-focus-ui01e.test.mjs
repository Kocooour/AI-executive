import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectorOpenerMatchesSelection, shouldRestoreInspectorFocus } from "../lib/inspector-return-focus.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const originA = { entityId: "task-a", workspaceId: "personal", view: "Today" };
const currentA = { workspaceId: "personal", view: "Today",
  rowEntityId: "task-a", connected: true, rendered: true };

test("UI-01e: an inspector opener must be a row of exactly the selected entity", () => {
  assert.equal(inspectorOpenerMatchesSelection("task-a", "task-a"), true);
  assert.equal(inspectorOpenerMatchesSelection("task-b", "task-a"), false,
    "an A button still focused after a pointer click on B must not be captured for B");
  assert.equal(inspectorOpenerMatchesSelection("task-a", null), false,
    "direct URL, sidebar or non-row open has no eligible row opener");
});

test("UI-01e: Back/close returns focus only to a connected visible row in original scope", () => {
  assert.equal(shouldRestoreInspectorFocus(originA, currentA), true);
  assert.equal(shouldRestoreInspectorFocus(originA, { ...currentA, rowEntityId: "task-b" }), false,
    "reused/rebound row element must not receive A's focus");
  assert.equal(shouldRestoreInspectorFocus(originA, { ...currentA, workspaceId: "shared" }), false,
    "switching workspace cancels focus return");
  assert.equal(shouldRestoreInspectorFocus(originA, { ...currentA, view: "Projects" }), false,
    "navigating to another view must not refocus an off-page row");
  assert.equal(shouldRestoreInspectorFocus(originA, { ...currentA, connected: false }), false);
  assert.equal(shouldRestoreInspectorFocus(originA, { ...currentA, rendered: false }), false);
  assert.equal(shouldRestoreInspectorFocus(null, currentA), false);
});

test("UI-01e: an A→B inspector selection never retains A's opener for B close", () => {
  // The component explicitly resets the stored opener before inspecting B.
  const app = read("../app/ui/views/detail-panel.tsx");
  assert.match(app, /if \(selected\) \{\s*\/\/ Reset on every selected ID or scope change,[\s\S]*?returnFocusRef\.current = null;/);
  assert.match(app, /active\.matches\("\.taskRowOpen"\) &&\s*inspectorOpenerMatchesSelection\(selected\.id, rowEntityId\)/);
  assert.match(app, /active\.closest<HTMLElement>\("\[data-drop-entity\]"\)\?\.dataset\.dropEntity/);
  assert.match(app, /origin: \{ entityId: selected\.id, workspaceId: app\.activeWorkspaceId, view \}/);
  assert.match(app, /returnFocusRef\.current = null; \/\/ Consume exactly once/);
  assert.match(app, /shouldRestoreInspectorFocus\(pending\.origin, \{/);
  assert.match(app, /opener\.isConnected, rendered: opener\.getClientRects\(\)\.length > 0/);
  assert.match(app, /opener\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /\}, \[selected\?\.id, app\.activeWorkspaceId, view\]\);/,
    "scope/view changes invalidate a pending origin immediately");
});

test("UI-01e: matching row metadata is used and no new navigation or server authority is introduced", () => {
  const rows = read("../app/ui/views/entity-list.tsx");
  assert.match(rows, /data-drop-entity=\{x\.id\}/);
  assert.match(rows, /className="taskRowOpen"/);
  const helper = read("../lib/inspector-return-focus.ts");
  assert.doesNotMatch(helper, /history\.|localStorage|sessionStorage|fetch\(|setSelected|db\./);
  const panel = read("../app/ui/views/detail-panel.tsx");
  assert.match(panel, /if \(!mobileDesignV1Preview\) return;/,
    "existing preview-only Escape behavior and keyboard affordance are unchanged");
});
