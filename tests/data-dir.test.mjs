import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const { resolveDataDirectory } = await import("../lib/data-dir.ts");

test("an absolute data directory is used as configured", () => {
  assert.equal(resolveDataDirectory({ AI_EXECUTIVE_DATA_DIR: "/var/lib/ai-executive" }), "/var/lib/ai-executive");
});

test("an absolute path is not normalized (\"..\" after a symlink resolves on disk, not in the string)", () => {
  assert.equal(resolveDataDirectory({ AI_EXECUTIVE_DATA_DIR: "/mnt/link/../state" }), "/mnt/link/../state");
});

test("the configured value is not trimmed (a path is used exactly as configured)", () => {
  assert.equal(resolveDataDirectory({ AI_EXECUTIVE_DATA_DIR: "/srv/Lumi " }), "/srv/Lumi ");
  assert.throws(() => resolveDataDirectory({ AI_EXECUTIVE_DATA_DIR: " /var/lib/ai-executive" }), /absolute/);
});

test("a relative data directory is rejected", () => {
  assert.throws(() => resolveDataDirectory({ AI_EXECUTIVE_DATA_DIR: ".data" }), /absolute/);
  assert.throws(() => resolveDataDirectory({ AI_EXECUTIVE_DATA_DIR: "../state" }), /absolute/);
});

test("an unset or blank value falls back to .data in the working directory", () => {
  const fallback = path.join(process.cwd(), ".data");
  assert.equal(resolveDataDirectory({}), fallback);
  assert.equal(resolveDataDirectory({ AI_EXECUTIVE_DATA_DIR: "   " }), fallback);
});
