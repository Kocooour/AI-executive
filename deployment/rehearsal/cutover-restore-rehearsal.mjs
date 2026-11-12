#!/usr/bin/env node
// Issue #408: copy-only, synthetic/offline archival SQLite rehearsal.
// This tool NEVER connects to the source DB. SQLite is opened only inside a NEW output directory.
// This is NOT a target journal/witness restore or a production cutover.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";

const quote = name => '"' + name.replaceAll('"', '""') + '"';
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
function statOrNull(file) {
  try { return lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
function safePaths(sources, output) {
  if (!path.isAbsolute(output) || sources.some(s => !path.isAbsolute(s))) throw Error("absolute paths required");
  const resolved = sources.map(source => {
    const real = realpathSync(source);
    if (!lstatSync(real).isDirectory()) throw Error("source must be an offline directory");
    return real;
  });
  const parent = realpathSync(path.dirname(output));
  const dst = path.join(parent, path.basename(output));
  if (statOrNull(dst)) throw Error("output must not already exist");
  for (const src of resolved) {
    if (within(src, dst) || within(dst, src)) throw Error("source/destination overlap");
  }
  const live = process.env.AI_EXECUTIVE_DATA_DIR;
  if (live && existsSync(live)) {
    const actual = realpathSync(live);
    if (resolved.some(src => within(src, actual))) throw Error("configured production data source refused");
  }
  return { resolved, dst };
}
function copySnapshot(src, output) {
  const dir = path.join(output, "store");
  mkdirSync(dir, { mode: 0o700 });
  const input = path.join(src, "store.sqlite");
  const files = ["", "-wal"].filter(suffix => statOrNull(input + suffix));
  if (!files.includes("")) throw Error("missing offline store.sqlite");
  const before = files.map(suffix => {
    const stat = lstatSync(input + suffix);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("unsafe source file");
    return { suffix, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  for (const { suffix } of before) {
    const dest = path.join(dir, "store.sqlite" + suffix);
    copyFileSync(input + suffix, dest, constants.COPYFILE_EXCL);
    chmodSync(dest, 0o600);
  }
  for (const { suffix, size, mtimeMs } of before) {
    const after = lstatSync(input + suffix);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== size || after.mtimeMs !== mtimeMs)
      throw Error("source changed while snapshot copied");
  }
  return path.join(dir, "store.sqlite");
}
const sha = text => createHash("sha256").update(text).digest("hex");
function shaFile(file) {
  const hash = createHash("sha256");
  const fd = openSync(file, "r"), buffer = Buffer.alloc(1 << 20);
  try {
    for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest("hex");
}
function encodeCell(value) {
  if (value === null) return ["null"];
  if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("base64")];
  if (typeof value === "string") return ["text", value];
  if (typeof value === "number") return ["number", value.toString()];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  return ["other", String(value)];
}
function describe(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok")
    throw Error("SQLite integrity check failed");
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0)
    throw Error("SQLite foreign key check failed");
  const definitions = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if (definitions.length === 0) throw Error("no application tables");
  const tables = {};
  for (const { name, sql } of definitions) {
    // Row content is never emitted. Hash per-row canonical typed data, sorted so storage
    // order and VACUUM's page/rowid changes cannot alter equality.
    const statement = db.prepare("SELECT * FROM " + quote(name));
    const rowHashes = [];
    for (const row of statement.iterate()) {
      const sorted = Object.entries(row).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, encodeCell(value)]);
      rowHashes.push(sha(JSON.stringify(sorted)));
    }
    rowHashes.sort();
    tables[name] = {
      count: rowHashes.length,
      schemaSha256: sha(sql === null ? "" : String(sql)),
      rowsSha256: sha(rowHashes.join("\n")),
    };
  }
  return tables;
}
function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return describe(db); } finally { db.close(); }
}
function equalTables(left, right) {
  const a = Object.keys(left).sort(), b = Object.keys(right).sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) throw Error("missing/extra table");
  for (const table of a) {
    if (left[table].count !== right[table].count
        || left[table].schemaSha256 !== right[table].schemaSha256
        || left[table].rowsSha256 !== right[table].rowsSha256)
      throw Error("row count, schema or content mismatch");
  }
}
function main() {
  const verify = process.argv[2] === "--verify";
  const expectedArgc = verify ? 6 : 4;
  if (process.argv.length !== expectedArgc) throw Error("usage: rehearsal <offline-source-dir> <new-output-dir> OR rehearsal --verify <expected-offline-dir> <candidate-offline-dir> <new-output-dir>");
  const sourceArgs = verify ? [process.argv[3], process.argv[4]] : [process.argv[2]];
  const outArg = verify ? process.argv[5] : process.argv[3];
  const { resolved, dst } = safePaths(sourceArgs, outArg);
  mkdirSync(dst, { mode: 0o700 });

  const expected = copySnapshot(resolved[0], makeDir(dst, "expected"));
  const expectedTables = inspect(expected);
  let candidate, archiveSha256 = null;
  if (verify) {
    candidate = copySnapshot(resolved[1], makeDir(dst, "candidate"));
  } else {
    const archiveDir = makeDir(dst, "archive");
    const archiveFile = path.join(archiveDir, "store.sqlite");
    // VACUUM INTO generates a transactionally consistent, full-content SQLite archive
    // from the PRIVATE COPY, never from the original. No app backup table filtering.
    const snapshot = new DatabaseSync(expected, { readOnly: true });
    try { snapshot.prepare("VACUUM INTO ?").run(archiveFile); }
    finally { snapshot.close(); }
    chmodSync(archiveFile, 0o600);
    archiveSha256 = shaFile(archiveFile);
    const restoredDir = makeDir(dst, "restored");
    candidate = path.join(restoredDir, "store.sqlite");
    copyFileSync(archiveFile, candidate, constants.COPYFILE_EXCL);
    chmodSync(candidate, 0o600);
  }
  const restoredTables = inspect(candidate);
  equalTables(expectedTables, restoredTables);
  const report = {
    format: "lumi-r4-rehearsal-v1",
    verdict: "equal",
    mode: verify ? "verify-copies" : "archival-backup-restoration",
    sqliteIntegrity: "ok",
    applicationTableCount: Object.keys(expectedTables).length,
    archiveSha256,
    tables: expectedTables,
  };
  writeFileSync(path.join(dst, "rehearsal.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  process.stdout.write("R4 offline rehearsal: PASS; " + report.applicationTableCount + " application tables; row counts, schema/content hashes, SQLite integrity and foreign keys match.\n");
}
function makeDir(parent, name) {
  const dir = path.join(parent, name);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
try { main(); }
catch (error) {
  // Never print source paths, SQL errors, content or a user-defined table name.
  console.error("R4 offline rehearsal: FAIL (" + (error instanceof Error ? error.constructor.name : "error") + ")");
  process.exitCode = 1;
}
