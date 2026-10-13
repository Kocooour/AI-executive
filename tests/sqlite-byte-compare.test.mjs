import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const runbook = readFileSync(path.resolve("docs/PRECHOD-SYSTEMOVY-UCET.md"), "utf8");
const helper = runbook.match(/^cmp_sqlite_bytes\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(helper, "migration runbook must contain cmp_sqlite_bytes");
const portableHelper = helper.replace("/usr/bin/node", process.execPath);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const main = { mainFileBytes: 4, mainFileSha256: sha("main"), walBytes: null, walSha256: null };
const emptyWal = { ...main, walBytes: 0, walSha256: sha("") };
const dataWal = { ...main, walBytes: 3, walSha256: sha("wal") };

function compare(before, after) {
  const dir = mkdtempSync(path.join(tmpdir(), "sqlite-byte-compare-"));
  try {
    const a = path.join(dir, "before.json");
    const b = path.join(dir, "after.json");
    writeFileSync(a, JSON.stringify(before));
    writeFileSync(b, JSON.stringify(after));
    return spawnSync("bash", ["-c", `${portableHelper}\ncmp_sqlite_bytes "$1" "$2"`, "bash", a, b], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("migration byte comparison equates absent and empty WAL", () => {
  for (const [a, b] of [[main, main], [main, emptyWal], [emptyWal, main], [dataWal, dataWal]]) {
    const result = compare(a, b);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SQLITE SOUBORY: shodne/);
  }
});

test("migration byte comparison detects changed main file and nonempty WAL", () => {
  for (const [a, b, label] of [
    [main, { ...main, mainFileSha256: sha("diff") }, "hlavni soubor"],
    [main, { ...main, mainFileBytes: 5 }, "hlavni soubor"],
    [main, dataWal, "WAL"],
    [dataWal, { ...dataWal, walBytes: 4 }, "WAL"],
    [dataWal, { ...dataWal, walSha256: sha("diff") }, "WAL"],
  ]) {
    const result = compare(a, b);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, new RegExp(`SQLITE SOUBORY: ROZDIL \\(${label}\\)`));
  }
});

test("migration byte comparison rejects missing or malformed facts", () => {
  const invalid = [
    ...Object.keys(main).map((key) => Object.fromEntries(Object.entries(main).filter(([name]) => name !== key))),
    { ...main, mainFileBytes: "4" },
    { ...main, mainFileSha256: "bad" },
    { ...main, walBytes: "0", walSha256: sha("") },
    { ...main, walBytes: 0, walSha256: null },
    { ...main, walBytes: 0, walSha256: sha("not empty") },
    { ...main, walBytes: 3, walSha256: null },
    null,
  ];
  for (const facts of invalid) {
    for (const [a, b] of [[facts, main], [main, facts]]) {
      const result = compare(a, b);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /SQLITE SOUBORY: CHYBI FAKTA/);
    }
  }
});
