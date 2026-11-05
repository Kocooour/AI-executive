import assert from "node:assert/strict";
import test from "node:test";
import { verifiedProjectAreaTitle } from "../lib/capture-area-preview.ts";

const project = { id: "project:1", workspaceId: "personal" };
const area = { id: "area:1", type: "area", workspaceId: "personal", status: "active", title: "Rodina" };

test("UI-08c: the capture preview shows only the active project Area", () => {
  assert.equal(verifiedProjectAreaTitle(project, ["area:1"], [area]), "Rodina");
  assert.equal(verifiedProjectAreaTitle(project, [], [area]), null);
  assert.equal(verifiedProjectAreaTitle(project, ["area:1", "area:2"], [area]), null);
  assert.equal(verifiedProjectAreaTitle(undefined, ["area:1"], [area]), null);
});

test("UI-08c: missing, inactive, unrelated and cross-workspace Areas are never asserted", () => {
  assert.equal(verifiedProjectAreaTitle(project, ["missing"], [area]), null);
  assert.equal(verifiedProjectAreaTitle(project, ["area:1"], [{ ...area, status: "archived" }]), null);
  assert.equal(verifiedProjectAreaTitle(project, ["area:1"], [{ ...area, type: "task" }]), null);
  assert.equal(verifiedProjectAreaTitle(project, ["area:1"], [{ ...area, workspaceId: "family" }]), null);
  assert.equal(verifiedProjectAreaTitle(project, ["area:1"], [{ ...area, title: " " }]), null);
});
