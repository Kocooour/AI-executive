// Minimal Node 22 extension resolver for the isolated staging read subprocess.
// Production HTTP code stays bundled by Next; this loader affects only the
// dedicated, read-only child process, never the host application.
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[a-z]+$/i.test(specifier)) {
    return nextResolve(specifier + ".ts", context);
  }
  return nextResolve(specifier, context);
}
