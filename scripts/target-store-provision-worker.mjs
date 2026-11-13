#!/usr/bin/env node
// Internal worker: invoke via target-store-provision.mjs; the public wrapper
// masks only known Node experimental/type-strip warnings, not real errors.
// R4 / #422: operator-only creation and read-only verification of an isolated
// personal-v1 target store. Never enables runtime flags or touches legacy data.
import {
  chmodSync, constants, copyFileSync, lstatSync, mkdirSync,
  mkdtempSync, readdirSync, realpathSync, rmSync,
} from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isWithinPath as within } from "./r4-path-boundary.mjs";
import { isOwnedByOperator } from "./r4-store-ownership.mjs";
import { R4OperatorError, safeFailureReason } from "./r4-cli-errors.mjs";

const USAGE = "usage: target-store-provision.mjs <absolute-new-directory> <ownerUserId> --confirmed | --check <absolute-existing-directory>";
const OWNER_ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STORE_FILES = ["lumi-target.journal", "lumi-target-witness.sqlite", "lumi-target.sqlite"].sort();
const SETTINGS = [
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
];
const fail = message => { throw new R4OperatorError(message); };

function statOrNull(file) {
  try { return lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

// Preserve symlink-before-".." semantics for configured paths (including
// paths that do not yet exist). A dangling symlink fails closed.
function canonicalProspective(input) {
  if (!path.isAbsolute(input)) fail("known live directory configuration must be absolute");
  let current = path.parse(input).root;
  for (const part of input.slice(current.length).split(path.sep)) {
    if (!part || part === ".") continue;
    if (part === "..") { current = path.dirname(current); continue; }
    const next = path.join(current, part);
    if (statOrNull(next)) current = realpathSync(next);
    else current = next;
  }
  return current;
}

// A path is safe against an unprivileged *other UID* replacing entries only
// when every ancestor is owned by this operator or root. Non-sticky group/
// other-writable ancestors allow path substitution between lstat/chmod/copy.
// A sticky parent owned by root/the operator (e.g. /tmp) protects entries
// owned by this operator while permitting an ordinary private child.
function assertTrustedParent(stat) {
  const uid = process.getuid?.();
  if (typeof uid !== "number" || !stat?.isDirectory() || stat.isSymbolicLink() ||
      (stat.uid !== uid && stat.uid !== 0))
    fail("target parent ownership is untrusted");
  if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
    fail("target parent has unsafe group/other write permissions");
}

function safeTarget(input, mustExist) {
  if (typeof input !== "string" || !path.isAbsolute(input) ||
      path.resolve(input) !== input || /[\x00-\x1f\x7f]/.test(input))
    fail("a canonical absolute directory path is required");
  const root = path.parse(input).root;
  if (input === root) fail("filesystem root cannot be a target store");
  let current = root;
  assertTrustedParent(lstatSync(root));
  const parts = input.slice(root.length).split(path.sep);
  if (parts.some(part => !part || part === "." || part === ".."))
    fail("path aliases are not accepted");
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(current, parts[i]);
    const st = statOrNull(next);
    if (st?.isSymbolicLink()) fail("symlinks and path aliases are not accepted");
    if (i < parts.length - 1) {
      if (!st?.isDirectory()) fail("target parent directory must already exist");
      assertTrustedParent(st);
    }
    if (i === parts.length - 1) {
      if (mustExist && (!st || !st.isDirectory())) fail("target directory does not exist");
      if (!mustExist && st) fail("target directory already exists");
    }
    current = next;
  }
  // The parent was walked without symlinks; realpath is also checked before
  // the first write to catch a path changed during validation.
  const parent = path.dirname(input);
  if (realpathSync(parent) !== parent) fail("target parent changed during validation");
  for (const configured of [
    path.join(process.cwd(), ".data"),
    process.env.AI_EXECUTIVE_DATA_DIR,
    process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY,
  ]) {
    if (!configured || !configured.trim()) continue;
    const live = canonicalProspective(configured);
    if (within(input, live) || within(live, input))
      fail("target overlaps a known live data location");
  }
  return input;
}

function assertPrivateStore(directory) {
  // Enforce ownership before each read-only preflight and after validation.
  // A 0700 directory or 0600 file owned by another UID can still be modified
  // concurrently by that owner if this command is run with elevated privileges.
  const operatorUid = process.getuid?.();
  const dirStat = lstatSync(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() ||
      !isOwnedByOperator(dirStat, operatorUid))
    fail("target directory ownership or type is unsafe");
  if ((dirStat.mode & 0o7777) !== 0o700)
    fail("target directory permissions are not 0700");
  const names = readdirSync(directory).sort();
  if (JSON.stringify(names) !== JSON.stringify(STORE_FILES))
    fail("target store contains missing or unexpected files");
  for (const name of STORE_FILES) {
    const stat = lstatSync(path.join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() ||
        !isOwnedByOperator(stat, operatorUid))
      fail("target file ownership or type is unsafe");
    if ((stat.mode & 0o7777) !== 0o600)
      fail("target file permissions are not 0600");
  }
}

function readVerifiedStore(directory, inspect, expectedOwner, expectedGeneration) {
  assertPrivateStore(directory);
  const first = inspect({
    stagingDirectory: directory, mode: "r2-model",
    ...(expectedOwner ? { expectedOwnerUserId: expectedOwner } : {}),
    ...(expectedGeneration ? { expectedRestoreGeneration: expectedGeneration } : {}),
  });
  if (!first.ok) fail("target-store read-only preflight failed");
  const db = new DatabaseSync(path.join(directory, "lumi-target.sqlite"), { readOnly: true });
  let owner;
  let generation;
  try {
    const rows = db.prepare("SELECT owner_user_id FROM workspaces WHERE kind='personal'").all();
    if (rows.length !== 1 || typeof rows[0].owner_user_id !== "string" ||
        !OWNER_ID.test(rows[0].owner_user_id)) fail("target store must have exactly one personal owner");
    owner = rows[0].owner_user_id;
    generation = db.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get()?.value;
    if (typeof generation !== "string" || !UUID.test(generation))
      fail("target restore generation is invalid");
  } finally { db.close(); }
  if ((expectedOwner && owner !== expectedOwner) ||
      (expectedGeneration && generation !== expectedGeneration))
    fail("target identity or generation does not match bootstrap");
  const second = inspect({
    stagingDirectory: directory, mode: "r2-model",
    expectedOwnerUserId: owner, expectedRestoreGeneration: generation,
  });
  if (!second.ok) fail("target-store read-only preflight failed");
  assertPrivateStore(directory);
  return { directory, owner, generation };
}

function cleanupOwnedDirectory(directory, createdStat) {
  if (!createdStat) return;
  // Never recursively delete a pre-existing directory, or one substituted
  // after we created it. A failed cleanup is reported without raw OS details.
  const current = statOrNull(directory);
  if (!current || !current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== createdStat.dev || current.ino !== createdStat.ino)
    fail("private provision cleanup requires manual inspection");
  rmSync(directory, { recursive: true, force: false });
}

function provision(directory, ownerUserId, bootstrap, inspect) {
  safeTarget(directory, false);
  if (!OWNER_ID.test(ownerUserId)) fail("a stable owner user ID is required");
  // umask applies BEFORE any sensitive SQLite/witness file or temporary copy
  // is created; the explicit chmod checks below also enforce 0700/0600.
  process.umask(0o077);
  const tempRoot = mkdtempSync(path.join(path.dirname(directory), ".lumi-r4-provision-"));
  const tempStat = lstatSync(tempRoot);
  let targetStat = null;
  let published = false;
  try {
    chmodSync(tempRoot, 0o700);
    const temporaryStore = path.join(tempRoot, "store");
    const bootstrapped = bootstrap({
      stagingDirectory: temporaryStore, ownerUserId,
    });
    chmodSync(temporaryStore, 0o700);
    for (const name of STORE_FILES) chmodSync(path.join(temporaryStore, name), 0o600);
    readVerifiedStore(temporaryStore, inspect, ownerUserId, bootstrapped.restoreGeneration);

    // The destination itself is created with mkdir (exclusive). In contrast
    // to rename, this cannot replace even an existing EMPTY directory.
    safeTarget(directory, false);
    mkdirSync(directory, { mode: 0o700 });
    targetStat = lstatSync(directory);
    chmodSync(directory, 0o700);
    for (const name of STORE_FILES) {
      copyFileSync(path.join(temporaryStore, name), path.join(directory, name), constants.COPYFILE_EXCL);
      chmodSync(path.join(directory, name), 0o600);
    }
    const verified = readVerifiedStore(directory, inspect, ownerUserId, bootstrapped.restoreGeneration);
    cleanupOwnedDirectory(tempRoot, tempStat);
    published = true;
    return verified;
  } finally {
    if (!published) cleanupOwnedDirectory(directory, targetStat);
    if (!published && statOrNull(tempRoot)) cleanupOwnedDirectory(tempRoot, tempStat);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const checking = argv.length === 2 && argv[0] === "--check";
  const creating = argv.length === 3 && argv[2] === "--confirmed";
  if (!checking && !creating) fail(USAGE);
  const directory = checking ? argv[1] : argv[0];
  if (checking) safeTarget(directory, true);
  else {
    safeTarget(directory, false);
    if (!OWNER_ID.test(argv[1])) fail("a stable owner user ID is required");
  }
  // The existing bootstrap/preflight use extensionless TypeScript imports.
  // Register the repository's resolver internally so operators need only node.
  register(new URL("./target-staging-ts-loader.mjs", import.meta.url), import.meta.url);
  const [{ bootstrapIsolatedTargetStore }, { inspectIsolatedTargetStore },
    { TARGET_PERSONAL_V1_REQUIRED_SETTINGS }] = await Promise.all([
    import("../lib/target-store-bootstrap.ts"),
    import("../lib/target-store-preflight.ts"),
    import("../lib/target-personal-profile.ts"),
  ]);
  if (JSON.stringify(TARGET_PERSONAL_V1_REQUIRED_SETTINGS.map(x => x.name)) !== JSON.stringify(SETTINGS))
    fail("operator setting contract mismatch");
  const result = checking
    ? readVerifiedStore(directory, inspectIsolatedTargetStore)
    : provision(directory, argv[1], bootstrapIsolatedTargetStore, inspectIsolatedTargetStore);
  process.stdout.write([
    SETTINGS[0] + "=" + result.directory,
    SETTINGS[1] + "=" + result.owner,
    SETTINGS[2] + "=" + result.generation,
  ].join("\n") + "\n");
}

main().catch(error => {
  process.stderr.write("R4 target provision: FAIL — " + safeFailureReason(error) +
    " (private paths and values suppressed)\n");
  process.exitCode = 1;
});
