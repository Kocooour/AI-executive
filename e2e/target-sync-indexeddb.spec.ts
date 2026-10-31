import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import ts from "typescript";

// R2c.5b: execute the real TypeScript implementation inside Chromium's real IndexedDB,
// not fake-indexeddb or a mocked storage backend. The adapter is not mounted in the UI
// until R3. Transpile its dependency-light modules into a test-only in-browser harness.
function compileModule(file: string, exported: readonly string[], prelude = ""): string {
  const source = readFileSync(resolve(process.cwd(), "lib/target-sync", file), "utf8");
  const javascript = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
    .replace(/^import .* from ["']\.\/storage["'];\s*$/gm, "")
    .replace(/^export \{\s*\};?\s*$/gm, "")
    .replace(/^export /gm, "");
  if (/^import\s/m.test(javascript) || /^export\s/m.test(javascript)) {
    throw new Error("Browser test harness encountered an unexpected runtime import/export: " + file);
  }
  return "(function () {\n" + prelude + "\n" + javascript +
    "\nreturn {" + exported.join(", ") + "};\n})()";
}

// The fake server uses Node Buffer only to encode/decode opaque test cursors.
const fakeBrowserPrelude = String.raw