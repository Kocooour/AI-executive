// Fixture-only, zero-decision demonstration; no real export or write path.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { rehearseSyntheticTriage } from "./triage-rehearsal.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/triage-rehearsal-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const paths = ["chatgpt", "claude"].map(name =>
      fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)));
    const bundles = await Promise.all(paths.map(async file =>
      JSON.parse(await readFile(file, "utf8"))));
    // No implicit triage choices, and no CLI input for injecting user data.
    console.log(JSON.stringify(rehearseSyntheticTriage(bundles, [])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
