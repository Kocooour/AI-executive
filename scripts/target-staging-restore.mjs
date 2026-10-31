/**
 * Operator-only CLI for R2c.4b: restore of an isolated staging store from a backup of
 * lumi-target.sqlite with the anti-rollback procedure. Not reachable over HTTP. Mechanism proposed for
 * owner approval (docs/ARCHITECTURE.md, R2c.4b).
 *
 * PROCEDURE
 *   1. Stop the server and every writer.
 *   2. Replace ONLY lumi-target.sqlite by a consistent backup made at the CURRENT schema version
 *      (sqlite3 ".backup" or VACUUM INTO). NEVER restore or copy back lumi-target.journal,
 *      lumi-target-witness.sqlite, the staging directory or a host snapshot: that rolls the irreversible
 *      source back and cannot be detected. A stale lumi-target.sqlite-journal is removed only by the
 *      rules of ARCHITECTURE R2c.4a. Until step 3 has finished every endpoint answers 503 restore_pending.
 *   3. Run this tool (same directory and CURRENT generation as the server's environment):
 *        node --experimental-loader ./scripts/target-staging-ts-loader.mjs \
 *          scripts/target-staging-restore.mjs --directory /abs/stage --generation <current-generation-uuid> \
 *          [--grant-admin <areaId>:<userId>]...
 *      It prints JSON with the NEW restoreGeneration (no tokens, no content). Exit 0 on success, 1 on refusal.
 *      A refusal leaves the store restore_pending and its state unchanged; the only thing a refusal may
 *      persist is the same tail resolution any writer performs first (cutting a torn journal fragment and
 *      confirming or aborting a trailing intent of a crashed writer, decided by the witness). Refusal
 *      reasons include invalid_request (also a --generation which is not a UUID), generation_mismatch (a
 *      well-formed --generation which is not this store's), last_admin, grant_invalid, grant_unneeded,
 *      capacity_exhausted (restore history or superseded-session table full: bootstrap a new store),
 *      confirm_untrusted (the restore COMMITTED but the store was not fully trusted afterwards, so no confirm was
 *      appended: do NOT set the new generation; the store fails closed until an operator inspects it).
 *   4. Set AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION to the printed value and start the server. While
 *      the configured generation differs the store fails closed. If the tool died after its commit and the
 *      output was lost, the new value is in the database: SELECT value FROM metadata WHERE key='restore_generation'.
 *
 * --grant-admin <areaId>:<userId> (repeatable, at most 16): operator decision when the replay would leave a
 *   shared Area without an admin (refusal reason "last_admin" lists the Areas). Only an Area which the
 *   last-admin invariant would block without the grant is accepted (else "grant_unneeded", nothing changes).
 *   The identity must exist; the grant may (re)add a user whom the journal removed. The decision is recorded
 *   as sorted [areaId,userId] pairs in the journal record of the restore and printed in the report.
 * --help: print this text.
 */
import path from "node:path";
import { restoreTargetStagingFromBackup } from "../lib/target-staging-restore.ts";

const USAGE = "usage: target-staging-restore.mjs --directory <abs staging dir> --generation <current restore generation uuid> [--grant-admin <areaId>:<userId>]...";
const ID = /^[A-Za-z0-9_.:@-]{1,120}$/;

/** Strict parser: known options only; only --grant-admin may repeat; no option-like values. */
function parse(argv) {
  const options = new Map();
  const grants = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const name = typeof flag === "string" && flag.startsWith("--") ? flag.slice(2) : "";
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return null;
    if (name === "grant-admin") {
      // Area IDs may themselves contain ":" (e.g. "area:unassigned:alice"): the separator is the LAST
      // ":", so a user ID with ":" cannot be named here (refused rather than guessed).
      const split = value.lastIndexOf(":");
      if (split < 1 || !ID.test(value.slice(0, split)) || !ID.test(value.slice(split + 1))) return null;
      grants.push({ areaId: value.slice(0, split), userId: value.slice(split + 1) });
      continue;
    }
    if ((name !== "directory" && name !== "generation") || options.has(name)) return null;
    options.set(name, value);
  }
  return { options, grants };
}

try {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(USAGE + "\n");
  } else {
    const parsed = parse(process.argv.slice(2));
    if (!parsed) throw new Error("Invalid arguments");
    const directory = parsed.options.get("directory");
    const generation = parsed.options.get("generation");
    if (!directory || !path.isAbsolute(directory) || !generation) throw new Error("Invalid arguments");
    const result = restoreTargetStagingFromBackup(
      { stagingDirectory: directory, expectedRestoreGeneration: generation },
      { grantAdmin: parsed.grants });
    process.stdout.write(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }
} catch {
  process.stdout.write(JSON.stringify({ ok: false, reason: "invalid_request", usage: USAGE }));
  process.exitCode = 1;
}
