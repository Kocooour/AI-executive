import assert from "node:assert/strict";
import test from "node:test";
import { lineDiff } from "../lib/line-diff.ts";

const show = (lines) => lines.map((line) => `${{ same: " ", added: "+", removed: "-" }[line.kind]}${line.text}`);

test("a line diff marks added and removed lines and keeps common ones", () => {
  assert.deepEqual(show(lineDiff("a\nb\nc", "a\nx\nc\nd")), [" a", "-b", "+x", " c", "+d"]);
  assert.deepEqual(show(lineDiff("", "new")), ["+new"]);
  assert.deepEqual(show(lineDiff("old", "")), ["-old"]);
  assert.deepEqual(show(lineDiff("same", "same")), [" same"]);
});
