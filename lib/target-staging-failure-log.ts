/** Content-free staging diagnostics: no SQL, exception messages, stack, paths or tokens. */
const SAFE_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED", "EACCES", "ENOENT", "EMFILE", "ENFILE", "EPERM", "ENOSPC"]);
export function logStagingFailure(stage: string, reason: string, error?: unknown): void {
  const rawCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code : undefined;
  const code = typeof rawCode === "string" && SAFE_CODES.has(rawCode) ? rawCode : "none";
  // Stages and reasons are compile-time literals, never external input.
  console.error(`[target-staging] stage=${stage} reason=${reason} error_code=${code}`);
}
