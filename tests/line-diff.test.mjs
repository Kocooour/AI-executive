import assert from "node:assert/strict";
import test from "node:test";
import { collapseUnchanged, lineDiff } from "../lib/line-diff.ts";

const show = (lines) => lines.map((line) => `${{ same: " ", added: "+", removed: "-" }[line.kind]}${line.text}`);

test("a line diff marks added and removed lines and keeps common ones", () => {
  assert.deepEqual(show(lineDiff("a\nb\nc", "a\nx\nc\nd")), [" a", "-b", "+x", " c", "+d"]);
  assert.deepEqual(show(lineDiff("", "new")), ["+new"]);
  assert.deepEqual(show(lineDiff("old", "")), ["-old"]);
  assert.deepEqual(show(lineDiff("same", "same")), [" same"]);
});

test("long runs of unchanged lines are folded with two lines of context", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `l${index}`);
  const changed = lines.map((line) => (line === "l10" ? "changed" : line));
  const items = collapseUnchanged(lineDiff(lines.join("\n"), changed.join("\n")));
  assert.deepEqual(items.map((item) => (item.kind === "skipped" ? `skip${item.count}` : item.kind[0] + item.text)), [
    "skip8", "sl8", "sl9", "rl10", "achanged", "sl11", "sl12", "skip7"]);
  assert.deepEqual(collapseUnchanged(lineDiff("a", "a")), [{ kind: "skipped", count: 1 }]);
});
