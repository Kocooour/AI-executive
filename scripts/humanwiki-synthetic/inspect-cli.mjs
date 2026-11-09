// Read-only CLI: allowlisted fictional fixtures, no checkpoint or data writes.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseSyntheticBundle } from "./ingest.mjs";
import { inspectSyntheticImport } from "./inspect.mjs";

const fixture = process.argv[2];
if (process.argv.length !== 3 || !["chatgpt", "claude"].includes(fixture)) {
  console.error("Usage: node scripts/humanwiki-synthetic/inspect-cli.mjs chatgpt|claude");
  process.exitCode = 2;
} else {
  try {
    const file = fileURLToPath(new URL(`./fixtures/${fixture}.json`, import.meta.url));
    const parsed = parseSyntheticBundle(JSON.parse(await readFile(file, "utf8")));
    console.log(JSON.stringify(inspectSyntheticImport(parsed)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
