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
