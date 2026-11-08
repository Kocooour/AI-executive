/**
 * Operator-only CLI for R2d.2c.2g.2b.5 note-journal compaction of an isolated staging store.
 * Not reachable over HTTP. Same safety checks as target-staging-session.mjs: an
 * absolute staging directory plus its restore generation, pinned-fd write with a
 * canonical preflight inside the transaction.
 *
 *   node --experimental-loader ./scripts/target-staging-ts-loader.mjs \
 *     scripts/target-staging-compact-note-journal.mjs \
 *       --directory /abs/stage --generation <restore-generation-uuid> \
 *       [--retention-days 30]
 *
 * Retention defaults to the proposed 30 days; the minimum is 7. Prints JSON
 * ({ok, areas, deleted} or {ok:false, reason}); exit code 0 on success, 1 on refusal.
 */
import path from "node:path";
import {
  TARGET_STAGING_NOTE_JOURNAL_DEFAULT_RETENTION_DAYS, compactTargetStagingNoteJournal,
} from "../lib/target-staging-note-journal-compaction.ts";

const ALLOWED = new Set(["directory", "generation", "retention-days"]);

/** Strict parser: known options only, no duplicates, no option-like values. */
function parse(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const name = typeof flag === "string" && flag.startsWith("--") ? flag.slice(2) : "";
    const value = argv[index + 1];
    if (!ALLOWED.has(name) || options.has(name) || value === undefined || value.startsWith("--")) return null;
    options.set(name, value);
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  if (!options) throw new Error("Invalid arguments");
  const directory = options.get("directory");
  const generation = options.get("generation");
  if (!directory || !path.isAbsolute(directory) || !generation) throw new Error("Invalid arguments");
  const days = options.has("retention-days") ? options.get("retention-days") : undefined;
  if (days !== undefined && !/^[0-9]{1,5}$/.test(days)) throw new Error("Invalid arguments");
  const result = compactTargetStagingNoteJournal(
    { stagingDirectory: directory, expectedRestoreGeneration: generation },
    { retentionDays: days === undefined ? TARGET_STAGING_NOTE_JOURNAL_DEFAULT_RETENTION_DAYS : Number(days),
      now: Date.now() });
  process.stdout.write(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch {
  process.stdout.write(JSON.stringify({ ok: false, reason: "invalid_request" }));
  process.exitCode = 1;
}
