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
import { R4OperatorError, safeFailureReason } from "../../scripts/r4-cli-errors.mjs";

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
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new R4OperatorError("missing/unsafe regular file");
  return stat;
}
function canonicalOutput(output) {
  if (!path.isAbsolute(output)) throw new R4OperatorError("absolute output required");
  const basename = path.basename(output);
  if (basename === "." || basename === "..") throw new R4OperatorError("unsafe output basename");
  const parent = realpathSync(path.dirname(output));
  const result = path.join(parent, basename);
  if (statOrNull(result)) throw new R4OperatorError("destination exists (must be new)");
  return result;
}
function safePaths(sources, output) {
  if (sources.some(source => !path.isAbsolute(source))) throw new R4OperatorError("absolute source required");
  const resolved = sources.map(source => {
    const real = realpathSync(source);
    if (!lstatSync(real).isDirectory()) throw new R4OperatorError("source must be an offline directory");
    return real;
  });
  // Every input must represent a distinct offline tree. In --verify mode,
  // accepting the same path twice would compare a snapshot against itself and
  // produce false evidence of an independent backup. Canonical paths also
  // collapse symlink aliases, and containment rejects nested source trees.
  // Apply the rule to optional target/config inputs too, to prevent ambiguous
  // archive provenance. None of these checks can prove independent capture.
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (within(resolved[i], resolved[j]) || within(resolved[j], resolved[i]))
        throw new R4OperatorError("offline input directories must be distinct and non-overlapping");
    }
  }
  const dst = canonicalOutput(output);
  for (const src of resolved) {
    if (within(src, dst) || within(dst, src)) throw new R4OperatorError("source/destination overlap");
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
    if (!path.isAbsolute(configured)) throw new R4OperatorError("live directory config must be absolute");
    const live = existsSync(configured) ? realpathSync(configured) : path.resolve(configured);
    if (resolved.some(src => within(src, live) || within(live, src)) ||
        within(dst, live) || within(live, dst))
      throw new R4OperatorError("known live data location refused");
  }
  return { resolved, dst };
}
function ensureDir(parent, name) {
  const dir = path.join(parent, name);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
// Capture ORIGINAL metadata for the operator-only recovery manifest. Never
// chown archived copies or make secrets world-readable: the archive itself
// must remain 0700/0600 under the operator account.
function fileMetadata(st) {
  return { mode: st.mode & 0o7777, uid: st.uid, gid: st.gid };
}
// Capture the source root together with its descendants. The input-root
// owner/mode controls service access and must be part of both source stability
// checks and --verify equality, not just recorded in the private report.
function sourceTreeManifest(root) {
  return { root: fileMetadata(lstatSync(root)), entries: listTree(root) };
}
function listTree(root) {
  const result = [];
  const visit = (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(absolute, entry.name);
      const rel = path.join(relative, entry.name);
      const st = lstatSync(file);
      if (st.isSymbolicLink()) throw new R4OperatorError("symlinks are not accepted in an offline snapshot");
      if (st.isDirectory()) {
        result.push({ relative: rel, kind: "directory", ...fileMetadata(st) });
        visit(file, rel);
      } else if (st.isFile()) {
        result.push({ relative: rel, kind: "file", bytes: st.size, digest: fileSha256(file), ...fileMetadata(st) });
      } else {
        throw new R4OperatorError("non-regular filesystem entry refused");
      }
    }
  };
  visit(root, "");
  return result;
}
// Public evidence is only a single SHA-256 of the content/path list; a full
// file-level manifest including original permissions and owners is private.
function manifestHash(entries) {
  return sha(JSON.stringify(entries.map(x => [x.relative, x.kind, x.bytes ?? null, x.digest ?? null])));
}
function originalMetadataHash(entries) {
  return sha(JSON.stringify(entries));
}
function assertPrivateCopyModes(root, entries) {
  if ((lstatSync(root).mode & 0o7777) !== 0o700)
    throw new R4OperatorError("private archive root permissions mismatch");
  for (const item of entries) {
    const mode = lstatSync(path.join(root, item.relative)).mode & 0o7777;
    if (mode !== (item.kind === "directory" ? 0o700 : 0o600))
      throw new R4OperatorError("private archive file permissions mismatch");
  }
}
function copyTree(src, dst) {
  mkdirSync(dst, { mode: 0o700 });
  chmodSync(dst, 0o700);
  const original = sourceTreeManifest(src);
  const entries = original.entries;
  for (const item of entries) {
    const dest = path.join(dst, item.relative);
    if (item.kind === "directory") {
      mkdirSync(dest, { mode: 0o700 });
      chmodSync(dest, 0o700);
    } else {
      copyFileSync(path.join(src, item.relative), dest, constants.COPYFILE_EXCL);
      chmodSync(dest, 0o600);
    }
  }
  const after = sourceTreeManifest(src);
  if (originalMetadataHash(original) !== originalMetadataHash(after))
    throw new R4OperatorError("offline source content or metadata changed during copy");
  const written = listTree(dst);
  if (manifestHash(entries) !== manifestHash(written))
    throw new R4OperatorError("archived file manifest mismatch");
  assertPrivateCopyModes(dst, written);
  return original;
}
function copyDatabaseForInspection(sourceDir, root, name) {
  const local = ensureDir(root, name.replaceAll(".", "-"));
  const source = path.join(sourceDir, name);
  assertSafeFile(source);
  for (const suffix of ["", "-wal"]) {
    if (!statOrNull(source + suffix)) {
      if (suffix === "") throw new R4OperatorError("missing SQLite source");
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
    throw new R4OperatorError("SQLite integrity_check failed");
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0)
    throw new R4OperatorError("SQLite foreign_key_check failed");
  // Include indexes, triggers and views (especially privacy deletion triggers)
  // as well as all application tables. SQLite's sqlite_sequence affects AUTOINCREMENT.
  const definitions = db.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master " +
    "WHERE (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') " +
    "AND type IN ('table','index','trigger','view') ORDER BY type,name"
  ).all();
  const tables = definitions.filter(item => item.type === "table");
  if (!tables.length) throw new R4OperatorError("no application tables");
  const schemaSha256 = sha(JSON.stringify(definitions.map(x => [x.type, x.name, x.tbl_name, x.sql])));
  const fingerprints = {};
  for (const { name, sql } of tables) {
    const rowHashes = [];
    for (const row of db.prepare("SELECT * FROM " + quote(name)).iterate()) {
      if (rowHashes.length >= MAX_ROWS_PER_TABLE) throw new R4OperatorError("table exceeds safe row limit");
      const sorted = Object.entries(row).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, encodeCell(value)]);
      const encoded = JSON.stringify(sorted);
      if (Buffer.byteLength(encoded) > MAX_ROW_BYTES) throw new R4OperatorError("row exceeds safe size limit");
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
    throw new R4OperatorError("schema objects or SQLite metadata mismatch");
  const x = Object.keys(a.tables).sort(), y = Object.keys(b.tables).sort();
  if (JSON.stringify(x) !== JSON.stringify(y)) throw new R4OperatorError("missing/extra table");
  for (const table of x) {
    const before = a.tables[table], after = b.tables[table];
    if (before.count !== after.count ||
        before.schemaSha256 !== after.schemaSha256 ||
        before.rowsSha256 !== after.rowsSha256)
      throw new R4OperatorError("row count, schema or content mismatch");
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
  if (args.pop() !== "--offline-confirmed") throw new R4OperatorError("offline source confirmation required");
  if (args[0] === "--verify") {
    if (args.length !== 4) throw new R4OperatorError("usage: --verify <offline-expected-dir> <offline-candidate-dir> <new-output-dir> --offline-confirmed");
    return { verify: true, sourceArgs: [args[1], args[2]], out: args[3], targetIndex: null, configIndex: null };
  }
  if (args.length < 2 || (args.length - 2) % 2 !== 0)
    throw new R4OperatorError("usage: <offline-legacy> <new-output> [--target-offline <dir>] [--config-offline <dir>] --offline-confirmed");
  const sourceArgs = [args[0]], selected = {};
  for (let i = 2; i < args.length; i += 2) {
    const kind = args[i] === "--target-offline" ? "target" : args[i] === "--config-offline" ? "config" : null;
    if (!kind || selected[kind] !== undefined) throw new R4OperatorError("invalid or repeated offline source option");
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
  chmodSync(dst, 0o700);
  const privateManifest = {
    format: "lumi-r4-private-file-manifest-v1",
    archivePolicy: "private copy modes 0700 directories / 0600 files, owned by running operator",
    recoveryPolicy: "operator must reapply recorded source uid/gid/mode on approved isolated restore; never do so to this archive",
    trees: {},
  };
  const archive = ensureDir(dst, "archive");
  const restored = ensureDir(dst, "restored");
  const expectedDir = path.join(archive, "legacy");
  const candidateDir = args.verify
    ? resolved[1] : path.join(restored, "legacy");
  const expectedSnapshot = copyTree(resolved[0], expectedDir);
  const expectedManifest = expectedSnapshot.entries;
  privateManifest.trees.legacy = expectedSnapshot;
  if (args.verify) {
    // Candidate is also copied, so SQLite is never opened on either source.
    const candidateSnapshot = copyTree(resolved[1], path.join(restored, "candidate"));
    privateManifest.trees.candidate = candidateSnapshot;
    if (originalMetadataHash(expectedSnapshot) !== originalMetadataHash(candidateSnapshot))
      throw new R4OperatorError("offline candidate content or metadata mismatch");
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
    throw new R4OperatorError("restored directory manifest mismatch");

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
    const targetSnapshot = copyTree(resolved[args.targetIndex], targetArchive);
    privateManifest.trees.target = targetSnapshot;
    const targetEntries = targetSnapshot.entries;
    copyTree(targetArchive, targetRestored);
    if (manifestHash(targetEntries) !== manifestHash(listTree(targetRestored)))
      throw new R4OperatorError("target security archive restore mismatch");
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
    const configSnapshot = copyTree(resolved[args.configIndex], archivedConfig);
    privateManifest.trees.configuration = configSnapshot;
    const entries = configSnapshot.entries;
    copyTree(archivedConfig, restoredConfig);
    if (manifestHash(entries) !== manifestHash(listTree(restoredConfig)))
      throw new R4OperatorError("configuration artifact restore mismatch");
    config = { status: "bytes_verified", files: entries.filter(x => x.kind === "file").length,
      manifestSha256: manifestHash(entries) };
  }
  // This file is private evidence: original relative filenames, hashes, uid,
  // gid and permissions. It is deliberately NOT embedded in public JSON/console.
  // The manifest must remain available alongside the private archived trees.
  const privateManifestText = JSON.stringify(privateManifest, null, 2) + "\n";
  const privateManifestSha256 = sha(privateManifestText);
  writeFileSync(path.join(archive, "private-file-manifest.json"), privateManifestText,
    { mode: 0o600, flag: "wx" });
  // The archive stores private bytes at 0600/0700. Original owner/mode data
  // is intentionally recorded, NOT applied without separately approved restore.
  const report = {
    format: "lumi-r4-rehearsal-v2",
    // Comparing an archive with its own restored copy proves copy fidelity,
    // NOT that an independently captured snapshot is correct. --verify uses
    // distinct input roots but cannot establish independent acquisition.
    verdict: "equal",
    mode: args.verify ? "verify-copies" : "archival-backup-restoration",
    verificationScope: args.verify ? "distinct_offline_inputs_equal" : "single_source_copy_fidelity",
    independentCaptureEstablished: false,
    sqliteIntegrity: "ok",
    applicationTableCount: Object.keys(expected.tables).length,
    schemaSha256: expected.schemaSha256,
    archiveSha256,
    privateManifestSha256,
    privateManifestFormat: privateManifest.format,
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
  const outcome = args.verify
    ? "DISTINCT INPUT COPIES EQUAL (independent capture NOT proven)"
    : "SINGLE-SOURCE COPY FIDELITY VERIFIED (NOT independent verification)";
  process.stdout.write("R4 OFFLINE rehearsal: " + outcome + "; " + report.applicationTableCount +
    " tables; rows, schema objects and SQLite integrity checked. " +
    "Target coverage: " + target.status + "; external configuration: " + config.status +
    ". This is NOT cutover approval.\n");
}
try { main(); }
catch (error) {
  // Do not reveal sensitive SQLite errors, source paths or user-controlled names.
  console.error("R4 offline rehearsal: FAIL — " + safeFailureReason(error) + " (private paths and values suppressed)");
  process.exitCode = 1;
}
