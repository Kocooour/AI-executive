// CLI accepts bundled fixture names only. No file upload, network, app route, or real-export path.
import { readFile, rename, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { parseSyntheticBundle, advanceSyntheticImport } from "./ingest.mjs";
import { ensurePrivateCheckpointDirectory } from "./checkpoint.mjs";

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
    let prior = null;
    try { prior = JSON.parse(await readFile(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const state = advanceSyntheticImport(parsed, prior, step === undefined ? Infinity : Number(step));
    const temp = `${statePath}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, statePath);
    const directory = await open(stateDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    console.log(JSON.stringify({ fixture, source_id: state.source_id, imported_messages: state.next_message,
      staged_segments: state.records.length, complete: state.next_message === parsed.messages.length,
      checkpoint: statePath }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
