// Read-only synthetic fixture triage: no real file path or checkpoint access.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { previewSyntheticReviewQueue } from "./review-preview.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/review-preview-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const files = ["chatgpt", "claude"].map(name =>
      fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)));
    const bundles = await Promise.all(files.map(async file =>
      JSON.parse(await readFile(file, "utf8"))));
    console.log(JSON.stringify(previewSyntheticReviewQueue(bundles)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
