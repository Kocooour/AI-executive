#!/usr/bin/env node
// Fail closed when a targeted C16 regression silently selects a different
// Playwright test. The same check applies to --list and actual execution logs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function selectedDesktopTests(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  return clean.split(/\r?\n/).filter((line) => line.includes("[desktop] › ")).map((line) => {
    const match = line.match(/\[desktop\] › (?:e2e\/)?([^/:\s]+\.spec\.ts):\d+:\d+ › (.+)$/);
    if (!match) throw new Error(`Unrecognized Playwright desktop test line: ${line}`);
    // Execution lines append a duration, unlike --list. Strip only a final
    // Playwright timing suffix; preserve the exact underlying test title.
    const title = match[2].trim().replace(/ \\(\\d+(?:\\.\\d+)?(?:ms|s|m)\\)$/, "");
    return { file: match[1], title };
  });
}

export function assertOrderedPair(output, firstFile, firstTitle, secondFile, secondTitle) {
  const actual = selectedDesktopTests(output);
  const expected = [
    { file: path.basename(firstFile), title: firstTitle },
    { file: path.basename(secondFile), title: secondTitle },
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`C16 did not select and execute the required ordered pair. Expected ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
  }
  return actual;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.length !== 8) {
    throw new Error("Usage: node scripts/verify-release0-c16-pair.mjs <log> <first-file> <first-title> <second-file> <second-title> <stage>");
  }
  const [, , log, firstFile, firstTitle, secondFile, secondTitle, stage] = process.argv;
  if (!["selection", "execution"].includes(stage)) throw new Error("Expected selection or execution stage");
  const selected = assertOrderedPair(readFileSync(log, "utf8"), firstFile, firstTitle, secondFile, secondTitle);
  console.log(`C16 ${stage} verified: ${selected.map((test) => test.file).join(" → ")}`);
}
