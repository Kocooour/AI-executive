import assert from "node:assert/strict";
import test from "node:test";

const { workspaceTone } = await import("../app/ui/workspace-tone.ts");
const { personalWorkspaceId } = await import("../lib/db.ts");

const shared = (title, properties = {}) => ({ workspaceId: "shared-1", title, properties: { kind: "shared", ...properties } });

test("the aggregate view and the personal workspace keep their own tones", () => {
  assert.equal(workspaceTone("all", undefined), "all");
  assert.equal(workspaceTone(personalWorkspaceId, { workspaceId: personalWorkspaceId, title: "Moje věci", properties: {} }), "personal");
  assert.equal(workspaceTone("shared-1", shared("Tým", { kind: "personal" })), "personal");
});

test("an active workspace that is missing takes the personal tone, matching its fallback name", () => {
  assert.equal(workspaceTone("deleted-workspace", undefined), "personal");
});

test("a stored tone wins over the title", () => {
  assert.equal(workspaceTone("shared-1", shared("Rodina", { tone: "work" })), "work");
  assert.equal(workspaceTone("shared-1", shared("Kancelář", { tone: "family" })), "family");
  assert.equal(workspaceTone("shared-1", shared("Rodina", { tone: "purple" })), "family", "an unknown stored tone is ignored");
});

test("family titles in any Czech form, in English and German are recognised", () => {
  for (const title of ["Rodina", "Naše rodina", "Rodinné finance", "Rodinná pokladna", "RODINNÝ rozpočet", "Family", "Familie Novák"]) {
    assert.equal(workspaceTone("shared-1", shared(title)), "family", title);
  }
});

test("other shared workspaces are work, also when a word only contains the letters", () => {
  for (const title of ["Firma", "Klient Alfa", "Prorodinný"]) {
    assert.equal(workspaceTone("shared-1", shared(title)), "work", title);
  }
});
