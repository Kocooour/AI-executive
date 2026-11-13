#!/usr/bin/env node
// R4 / #408 — archival backup and verified restore on a DISPOSABLE OFFLINE COPY.
// No source SQLite connection, no live migration, no deletion, no flag activation.
// Only NEW output directories may be written. No output contains row values or filenames.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { isWithinPath as within } from "../../scripts/r4-path-boundary.mjs";

const MAX_ROWS_PER_TABLE = 200_000;
const MAX_ROW_BYTES = 16 * 1024 * 1024;
const TARGET_REQUIRED = ["lumi-target.sqlite", "lumi-target.journal", "lumi-target-witness.sqlite"];
const quote = name => '"' + name.replaceAll('"', '""') + '"';

const sha = value => createHash("sha256").update(value).digest("hex");
function statOrNull(file) {
  try { return lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
function fileSha256(file) {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(1 << 20);
  try {
    for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, n));
    }
  } finally { closeSync(fd); }
  return hash.digest("hex");
}
function assertSafeFile(file) {
  const stat = statOrNull(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw Error("missing/unsafe regular file");
  return stat;
}
function canonicalOutput(output) {
  if (!path.isAbsolute(output)) throw Error("absolute output required");
  const basename = path.basename(output);
  if (basename === "." || basename === "..") throw Error("unsafe output basename");
  const parent = realpathSync(path.dirname(output));
  const result = path.join(parent, basename);
  if (statOrNull(result)) throw Error("destination exists (must be new)");
  return result;
}
function safePaths(sources, output) {
  if (sources.some(source => !path.isAbsolute(source))) throw Error("absolute source required");
  const resolved = sources.map(source => {
    const real = realpathSync(source);
    if (!lstatSync(real).isDirectory()) throw Error("source must be an offline directory");
    return real;
  });
  const dst = canonicalOutput(output);
  for (const src of resolved) {
    if (within(src, dst) || within(dst, src)) throw Error("source/destination overlap");
  }
  // The environment cannot establish that a copy is truly offline, but can reject
  // known live locations. An operator must attest the copy is quiesced before use.
  const liveCandidates = [
    path.resolve(process.cwd(), ".data"), // implicit app default when env is unset
    process.env.AI_EXECUTIVE_DATA_DIR,
    process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY,
  ];
  for (const configured of liveCandidates) {
    if (!configured) continue;
    if (!path.isAbsolute(configured)) throw Error("live directory config must be absolute");
    const live = existsSync(configured) ? realpathSync(configured) : path.resolve(configured);
    if (resolved.some(src => within(src, live) || within(live, src)) ||
        within(dst, live) || within(live, dst))
      throw Error("known live data location refused");
  }
  return { resolved, dst };
}
function ensureDir(parent, name) {
  const dir = path.join(parent, name);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
function listTree(root) {
  const result = [];
  const visit = (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(absolute, entry.name);
      const rel = path.join(relative, entry.name);
      const st = lstatSync(file);
      if (st.isSymbolicLink()) throw Error("symlinks are not accepted in an offline snapshot");
      if (st.isDirectory()) {
        result.push({ relative: rel, kind: "directory" });
        visit(file, rel);
      } else if (st.isFile()) {
        result.push({ relative: rel, kind: "file", bytes: st.size, digest: fileSha256(file) });
      } else {
        throw Error("non-regular filesystem entry refused");
      }
    }
  };
  visit(root, "");
  return result;
}
function manifestHash(entries) {
  // Store neither file names nor personal content in public-facing evidence.
  return sha(JSON.stringify(entries));
}
function copyTree(src, dst) {
  mkdirSync(dst, { mode: 0o700 });
  const entries = listTree(src);
  for (const item of entries) {
    const dest = path.join(dst, item.relative);
    if (item.kind === "directory") mkdirSync(dest, { mode: 0o700 });
    else {
      copyFileSync(path.join(src, item.relative), dest, constants.COPYFILE_EXCL);
      chmodSync(dest, 0o600);
    }
  }
  const after = listTree(src);
  if (manifestHash(entries) !== manifestHash(after))
    throw Error("offline source changed during copy");
  const written = listTree(dst);
  if (manifestHash(entries) !== manifestHash(written))
    throw Error("archived file manifest mismatch");
  return entries;
}
function copyDatabaseForInspection(sourceDir, root, name) {
  const local = ensureDir(root, name.replaceAll(".", "-"));
  const source = path.join(sourceDir, name);
  assertSafeFile(source);
  for (const suffix of ["", "-wal"]) {
    if (!statOrNull(source + suffix)) {
      if (suffix === "") throw Error("missing SQLite source");
      continue;
    }
    assertSafeFile(source + suffix);
    const dest = path.join(local, name + suffix);
    copyFileSync(source + suffix, dest, constants.COPYFILE_EXCL);
    chmodSync(dest, 0o600);
  }
  return path.join(local, name);
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
    throw Error("SQLite integrity_check failed");
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0)
    throw Error("SQLite foreign_key_check failed");
  // Include indexes, triggers and views (especially privacy deletion triggers)
  // as well as all application tables. SQLite's sqlite_sequence affects AUTOINCREMENT.
  const definitions = db.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master " +
    "WHERE (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') " +
    "AND type IN ('table','index','trigger','view') ORDER BY type,name"
  ).all();
  const tables = definitions.filter(item => item.type === "table");
  if (!tables.length) throw Error("no application tables");
  const schemaSha256 = sha(JSON.stringify(definitions.map(x => [x.type, x.name, x.tbl_name, x.sql])));
  const fingerprints = {};
  for (const { name, sql } of tables) {
    const rowHashes = [];
    for (const row of db.prepare("SELECT * FROM " + quote(name)).iterate()) {
      if (rowHashes.length >= MAX_ROWS_PER_TABLE) throw Error("table exceeds safe row limit");
      const sorted = Object.entries(row).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, encodeCell(value)]);
      const encoded = JSON.stringify(sorted);
      if (Buffer.byteLength(encoded) > MAX_ROW_BYTES) throw Error("row exceeds safe size limit");
      rowHashes.push(sha(encoded));
    }
    rowHashes.sort();
    fingerprints[name] = {
      count: rowHashes.length,
      schemaSha256: sha(sql === null ? "" : String(sql)),
      rowsSha256: sha(rowHashes.join("\n")),
    };
  }
  const version = db.prepare("PRAGMA user_version").get().user_version;
  const application = db.prepare("PRAGMA application_id").get().application_id;
  return { schemaSha256, tables: fingerprints, version, application };
}
function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return describe(db); }
  finally { db.close(); }
}
function assertEqualDescriptions(a, b) {
  if (a.schemaSha256 !== b.schemaSha256 ||
      a.version !== b.version ||
      a.application !== b.application)
    throw Error("schema objects or SQLite metadata mismatch");
  const x = Object.keys(a.tables).sort(), y = Object.keys(b.tables).sort();
  if (JSON.stringify(x) !== JSON.stringify(y)) throw Error("missing/extra table");
  for (const table of x) {
    const before = a.tables[table], after = b.tables[table];
    if (before.count !== after.count ||
        before.schemaSha256 !== after.schemaSha256 ||
        before.rowsSha256 !== after.rowsSha256)
      throw Error("row count, schema or content mismatch");
  }
}
function checkTarget(targetDir, inspectionRoot, tag) {
  for (const required of TARGET_REQUIRED) assertSafeFile(path.join(targetDir, required));
  const a = inspect(copyDatabaseForInspection(targetDir, ensureDir(inspectionRoot, tag), "lumi-target.sqlite"));
  const w = inspect(copyDatabaseForInspection(targetDir, ensureDir(inspectionRoot, tag + "-witness"), "lumi-target-witness.sqlite"));
  return { target: a, witness: w };
}
function parseArgs() {
  const args = process.argv.slice(2);
  // Require affirmative operator knowledge of the input's offline/quiesced
  // capture. The flag alone does not constitute proof of snapshot consistency.
  if (args.pop() !== "--offline-confirmed") throw Error("offline source confirmation required");
  if (args[0] === "--verify") {
    if (args.length !== 4) throw Error("usage: --verify <offline-expected-dir> <offline-candidate-dir> <new-output-dir> --offline-confirmed");
    return { verify: true, sourceArgs: [args[1], args[2]], out: args[3], targetIndex: null, configIndex: null };
  }
  if (args.length < 2 || (args.length - 2) % 2 !== 0)
    throw Error("usage: <offline-legacy> <new-output> [--target-offline <dir>] [--config-offline <dir>] --offline-confirmed");
  const sourceArgs = [args[0]], selected = {};
  for (let i = 2; i < args.length; i += 2) {
    const kind = args[i] === "--target-offline" ? "target" : args[i] === "--config-offline" ? "config" : null;
    if (!kind || selected[kind] !== undefined) throw Error("invalid or repeated offline source option");
    selected[kind] = sourceArgs.length;
    sourceArgs.push(args[i + 1]);
  }
  return { verify: false, sourceArgs, out: args[1],
    targetIndex: selected.target ?? null, configIndex: selected.config ?? null };
}
function main() {
  const args = parseArgs();
  const { resolved, dst } = safePaths(args.sourceArgs, args.out);
  mkdirSync(dst, { mode: 0o700 });
  const archive = ensureDir(dst, "archive");
  const restored = ensureDir(dst, "restored");
  const expectedDir = path.join(archive, "legacy");
  const candidateDir = args.verify
    ? resolved[1] : path.join(restored, "legacy");
  const expectedManifest = copyTree(resolved[0], expectedDir);
  if (args.verify) {
    // Candidate is also copied, so SQLite is never opened on either source.
    copyTree(resolved[1], path.join(restored, "candidate"));
  } else {
    copyTree(expectedDir, candidateDir);
  }
  const inspectedCandidate = args.verify ? path.join(restored, "candidate") : candidateDir;
  const candidateManifest = listTree(inspectedCandidate);
  const inspectionRoot = ensureDir(dst, "inspection");
  const expectedDatabase = copyDatabaseForInspection(expectedDir, ensureDir(inspectionRoot, "expected"), "store.sqlite");
  const actualDatabase = copyDatabaseForInspection(inspectedCandidate, ensureDir(inspectionRoot, "candidate"), "store.sqlite");
  const expected = inspect(expectedDatabase);
  const actual = inspect(actualDatabase);
  assertEqualDescriptions(expected, actual);
  if (manifestHash(expectedManifest) !== manifestHash(candidateManifest))
    throw Error("restored directory manifest mismatch");

  // Independent VACUUM INTO on a disposable copy. Unlike an app-format-2
  // filtered export, the resulting archive contains all SQLite tables.
  let archiveSha256 = null;
  if (!args.verify) {
    const snapshot = new DatabaseSync(expectedDatabase, { readOnly: true });
    const file = path.join(archive, "archival-store.sqlite");
    try { snapshot.prepare("VACUUM INTO ?").run(file); }
    finally { snapshot.close(); }
    chmodSync(file, 0o600);
    archiveSha256 = fileSha256(file);
    const archivalDescription = inspect(file);
    assertEqualDescriptions(expected, archivalDescription);
  }
  let target = { status: "not_provided" };
  if (args.targetIndex !== null) {
    // Target is a separate original directory; copy all files including the
    // immutable journal and witness, and verify byte-for-byte restore as a unit.
    const targetArchive = path.join(archive, "target");
    const targetRestored = path.join(restored, "target");
    const targetEntries = copyTree(resolved[args.targetIndex], targetArchive);
    copyTree(targetArchive, targetRestored);
    if (manifestHash(targetEntries) !== manifestHash(listTree(targetRestored)))
      throw Error("target security archive restore mismatch");
    const before = checkTarget(targetArchive, inspectionRoot, "target-before");
    const after = checkTarget(targetRestored, inspectionRoot, "target-after");
    assertEqualDescriptions(before.target, after.target);
    assertEqualDescriptions(before.witness, after.witness);
    target = { status: "bytes_and_sqlite_verified",
      files: targetEntries.filter(row => row.kind === "file").length,
      manifestSha256: manifestHash(targetEntries) };
  }
  let config = { status: "not_provided" };
  if (args.configIndex !== null) {
    // Environment-only credentials may live outside the normal data directory;
    // they require a separately prepared OFFLINE copy. Never print their names.
    const archivedConfig = path.join(archive, "configuration");
    const restoredConfig = path.join(restored, "configuration");
    const entries = copyTree(resolved[args.configIndex], archivedConfig);
    copyTree(archivedConfig, restoredConfig);
    if (manifestHash(entries) !== manifestHash(listTree(restoredConfig)))
      throw Error("configuration artifact restore mismatch");
    config = { status: "bytes_verified", files: entries.filter(x => x.kind === "file").length,
      manifestSha256: manifestHash(entries) };
  }
  // The whole offline snapshot is preserved with original paths in mode 0700/0600;
  // JSON evidence contains only digests/counters and no path, title or secret.
  const report = {
    format: "lumi-r4-rehearsal-v2",
    verdict: "equal",
    mode: args.verify ? "verify-copies" : "archival-backup-restoration",
    sqliteIntegrity: "ok",
    applicationTableCount: Object.keys(expected.tables).length,
    schemaSha256: expected.schemaSha256,
    archiveSha256,
    snapshot: {
      files: expectedManifest.filter(x => x.kind === "file").length,
      manifestSha256: manifestHash(expectedManifest),
    },
    target,
    externalConfiguration: config,
    limitations: [
      "input must be an independently quiesced, consistent offline snapshot",
      "byte-accurate journal/witness restore is not a semantic target anti-rollback preflight",
    ],
    tables: expected.tables,
    boundedRowsPerTable: MAX_ROWS_PER_TABLE,
  };
  writeFileSync(path.join(dst, "rehearsal.json"), JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600, flag: "wx" });
  process.stdout.write("R4 OFFLINE rehearsal: PASS; " + report.applicationTableCount +
    " tables; table rows, schema objects, SQLite integrity and directory backup/restore match. " +
    "Target coverage: " + target.status + "; external configuration: " + config.status + ". This is NOT cutover approval.\n");
}
try { main(); }
catch (error) {
  // Do not reveal sensitive SQLite errors, source paths or user-controlled names.
  console.error("R4 offline rehearsal: FAIL (" + (error instanceof Error ? error.constructor.name : "error") + ")");
  process.exitCode = 1;
}
