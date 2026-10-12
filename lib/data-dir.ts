import path from "node:path";

/**
 * Directory for all mutable server state (SQLite, backups, security outbox default).
 * A configured `AI_EXECUTIVE_DATA_DIR` must be absolute: a relative value would silently depend on
 * the working directory, which changes when the service moves to its own account and code directory.
 * Unset keeps the development default `<cwd>/.data`.
 */
export function resolveDataDirectory(env: Record<string, string | undefined> = process.env) {
  const configured = env.AI_EXECUTIVE_DATA_DIR?.trim();
  if (!configured) return path.join(process.cwd(), ".data");
  if (!path.isAbsolute(configured)) {
    throw new Error("AI_EXECUTIVE_DATA_DIR must be an absolute path.");
  }
  // Used as configured, not normalized: with a symlink before "..", normalizing would point
  // somewhere else than the file system does (and than the running service did before).
  return configured;
}
