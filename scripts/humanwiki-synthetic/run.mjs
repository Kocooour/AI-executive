// CLI accepts bundled fixture names only. No file upload, network, app route, or real-export path.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { parseSyntheticBundle, advanceSyntheticImport } from "./ingest.mjs";
import { ensurePrivateCheckpointDirectory, writeCheckpointAtomic } from "./checkpoint.mjs";

const fixture = process.argv[2];
const step = process.argv[3];
if (!["chatgpt", "claude"].includes(fixture) || process.argv.length > 4 ||
  (step !== undefined && !/^[1-9]\d{0,3}$/.test(step))) {
  console.error("Usage: node scripts/humanwiki-synthetic/run.mjs chatgpt|claude [messages-per-run]");
  process.exitCode = 2;
} else {
  const fixturePath = fileURLToPath(new URL(`./fixtures/${fixture}.json`, import.meta.url));
  const stateDir = path.join(os.tmpdir(), "lumi-humanwiki-synthetic-lab");
  const statePath = path.join(stateDir, `${fixture}.checkpoint.json`);
  try {
    const parsed = parseSyntheticBundle(JSON.parse(await readFile(fixturePath, "utf8")));
    await ensurePrivateCheckpointDirectory(stateDir);
    let prior;
    try { prior = JSON.parse(await readFile(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const state = advanceSyntheticImport(parsed, prior, step === undefined ? Infinity : Number(step));
    await writeCheckpointAtomic(stateDir, statePath, state);
    console.log(JSON.stringify({ fixture, source_id: state.source_id, imported_messages: state.next_message,
      staged_segments: state.records.length, complete: state.next_message === parsed.messages.length,
      checkpoint: statePath }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
