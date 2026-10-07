import assert from "node:assert/strict";
import test from "node:test";

const { addressUpdate, searchForView, viewFromSearch } = await import("../lib/view-url.ts");
const known = ["Home", "Inbox", "Today", "Settings"];

test("only a known view name is read from the address", () => {
  assert.equal(viewFromSearch("?view=Today", known), "Today");
  assert.equal(viewFromSearch("?view=today", known), null);
  assert.equal(viewFromSearch("?view=Nope", known), null);
  assert.equal(viewFromSearch("?task=abc", known), null);
  assert.equal(viewFromSearch("", known), null);
  assert.equal(viewFromSearch("?view=Today&view=Inbox", known), "Today");
});

test("the start view has a plain address, every other view is named", () => {
  assert.equal(searchForView("Home", "Home"), "");
  assert.equal(searchForView("Today", "Home"), "?view=Today");
  assert.equal(searchForView("Home", "Inbox"), "?view=Home");
  assert.equal(searchForView("Inbox", "Inbox"), "");
});

test("the address never keeps a record id or any other parameter", () => {
  const update = addressUpdate({ currentSearch: "?task=secret-id&workspace=personal", view: "Today", startView: "Home", navigated: false });
  assert.deepEqual(update, { search: "?view=Today", mode: "replace" });
  assert.deepEqual(addressUpdate({ currentSearch: "?task=secret-id", view: "Home", startView: "Home", navigated: false }), { search: "", mode: "replace" });
});

test("navigating adds a history step, corrections do not, and a matching address is left alone", () => {
  assert.deepEqual(addressUpdate({ currentSearch: "", view: "Today", startView: "Home", navigated: true }), { search: "?view=Today", mode: "push" });
  assert.deepEqual(addressUpdate({ currentSearch: "?view=Today", view: "Today", startView: "Inbox", navigated: false }), null);
  assert.equal(addressUpdate({ currentSearch: "?view=Today", view: "Today", startView: "Home", navigated: true }), null);
  assert.deepEqual(addressUpdate({ currentSearch: "", view: "Home", startView: "Inbox", navigated: false }), { search: "?view=Home", mode: "replace" });
});
