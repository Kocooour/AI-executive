import assert from "node:assert/strict";
import test from "node:test";
import { requestsTypedRecord, showUnavailableLink } from "../lib/navigation-link-status.ts";

test("UI-01c: missing or malformed typed target gets a generic notice", () => {
  for (const search of [
    "?view=Projects&projectId=missing",
    "?view=Today&taskId=missing",
    "?view=Notes&noteId=missing",
    "?view=Projects&projectId=&taskId=foo",
    "?view=Today&taskId=a&taskId=b",
    "?view=Today&taskId=%00",
  ]) {
    assert.equal(requestsTypedRecord(search), true, search);
    assert.equal(showUnavailableLink(search, false), true, search);
  }
});

test("UI-01c: a resolved link never receives unavailable notice", () => {
  assert.equal(showUnavailableLink("?view=Projects&projectId=valid", true), false);
  assert.equal(showUnavailableLink("?view=Today&taskId=valid", true), false);
});

test("UI-01c: plain views and legacy task notifications are unaffected", () => {
  for (const search of ["", "?view=Home", "?view=Projects", "?task=legacy-notification", "?view=MyPlanPreview"]) {
    assert.equal(requestsTypedRecord(search), false, search);
    assert.equal(showUnavailableLink(search, false), false, search);
  }
});
