// R4 offline tooling: only explicitly authored, static operator messages may
// reach stderr. Never print raw OS/SQLite error text (which may include paths,
// SQL values or other data from a sensitive snapshot).
export class R4OperatorError extends Error {
  constructor(safeMessage) {
    super(safeMessage);
    this.name = "R4OperatorError";
  }
}

const FILESYSTEM_FAILURES = Object.freeze({
  ENOENT: "required input or output parent does not exist",
  EACCES: "filesystem permission denied",
  EPERM: "filesystem operation not permitted",
  ENOSPC: "insufficient disk space for private copy or report",
  EROFS: "output filesystem is read-only",
  EEXIST: "output already exists; use a new destination",
  EMFILE: "too many open files",
  ENOTDIR: "an expected directory path is not a directory",
  EISDIR: "an expected file is a directory",
});

export function safeFailureReason(error) {
  if (error instanceof R4OperatorError) return error.message;
  // Include only a fixed allowlist of known native error categories, not
  // arbitrary error.code or error.message returned by the filesystem/SQLite.
  const code = error?.code;
  if (Object.hasOwn(FILESYSTEM_FAILURES, code)) return FILESYSTEM_FAILURES[code];
  if (typeof code === "string" && /^ERR_SQLITE_/.test(code))
    return "copied SQLite database cannot be read or validated";
  return "unexpected failure; inspect the offline input and operator environment";
}
