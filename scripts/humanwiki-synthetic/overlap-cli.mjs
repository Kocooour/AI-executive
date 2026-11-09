// Fixed synthetic fixtures only; read-only, no real file path or checkpoint access.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { previewSyntheticOverlaps } from "./overlap.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/overlap-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const files = ["chatgpt", "claude"].map(name =>
      fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)));
    const bundles = await Promise.all(files.map(async file =>
      JSON.parse(await readFile(file, "utf8"))));
    console.log(JSON.stringify(previewSyntheticOverlaps(bundles)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
