import assert from "node:assert/strict";
import test from "node:test";
import { clampTaskMinutes, taskMinutes } from "../lib/task-duration.ts";

test("task duration accepts whole minutes from one through 480", () => {
  for (const minutes of [1, 4, 9, 10, 480]) assert.equal(taskMinutes(String(minutes)), minutes);
  for (const value of ["", 0, 481, 1.5, "abc"]) assert.equal(taskMinutes(value), null);
  assert.equal(clampTaskMinutes(0), 1);
  assert.equal(clampTaskMinutes(481), 480);
});
