import { readFile } from "node:fs/promises";
import ts from "typescript";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)) {
    try { return await nextResolve(`${specifier}.ts`, context); } catch { /* use the regular resolver below */ }
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // Next's own entry points (next/server) are CommonJS files without an extension.
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /^next\/[a-z-]+$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
    if (error?.code === "ERR_MODULE_NOT_FOUND" && (specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}

// Node 22 can strip .ts syntax but does not natively load .tsx. Compile only
// explicitly imported TSX for Node's unit/SSR runner; production Next builds
// keep their own compiler, and every other module uses Node's normal loader.
export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !url.endsWith(".tsx")) {
    return nextLoad(url, context);
  }
  const source = await readFile(new URL(url), "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: new URL(url).pathname,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  return { format: "module", source: compiled.outputText, shortCircuit: true };
}
