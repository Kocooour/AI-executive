/** Explicit, read-only inspection of an existing R1 target staging database. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TARGET_SCHEMA_SQL, TARGET_STORE_FILENAME, TARGET_STORE_SCHEMA_VERSION,
  TARGET_STAGING_MAX_RECEIPTS, TARGET_STAGING_RECEIPT_PREFIX, verifyExistingTargetStagingPath,
} from "./target-store-bootstrap";

export type TargetPreflightMode = "stage" | "r2-model";
export type TargetPreflightCode =
  | "unsafe_path" | "missing_database" | "database_open_failed" | "database_query_failed"
  | "metadata_invalid" | "schema_invalid" | "expected_owner_mismatch" | "expected_generation_mismatch"
  | "quick_check_failed" | "integrity_check_failed" | "foreign_key_failed"
  | "personal_workspace_invalid" | "unassigned_area_invalid" | "task_area_invalid"
  | "assignee_invalid" | "shared_mapping_invalid" | "shared_admin_missing";

export interface TargetPreflightOptions {
  stagingDirectory: string;
  /** This validates identity data, not an authenticated actor. */
  expectedOwnerUserId?: string;
  expectedRestoreGeneration?: string;
  /** Additional model checks for R2 planning; still NOT activation readiness. */
  mode?: TargetPreflightMode;
}

export interface TargetPreflightResult {
  ok: boolean;
  mode: TargetPreflightMode;
  issues: TargetPreflightCode[];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Hex = /^[a-f0-9]{64}$/;
const CONTROL_METADATA_KEYS = new Set([
  "schema_version", "activated", "write_protocol", "restore_generation",
]);
/** Compare the complete stored DDL, not just names: a same-name no-op trigger is unsafe. */
function matchesCanonicalSchema(actual: DatabaseSync): boolean {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(TARGET_SCHEMA_SQL);
    const schema = (db: DatabaseSync) => db.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name",
    ).all();
    return JSON.stringify(schema(actual)) === JSON.stringify(schema(expected));
  } finally {
    expected.close();
  }
}

/** No task content, IDs, paths or raw SQLite messages are returned or logged. */
/** Validate the same pinned file/SQLite snapshot later used for an authorized read. */
export interface TargetPinnedPreflightConnection {
  readonly db: DatabaseSync;
  readonly fd: number;
}

export function inspectIsolatedTargetStore(
  options: TargetPreflightOptions,
  pinned?: TargetPinnedPreflightConnection,
): TargetPreflightResult {
  const mode = options?.mode === "r2-model" ? "r2-model" : "stage";
  const issues: TargetPreflightCode[] = [];
  const fail = (code: TargetPreflightCode) => { if (!issues.includes(code)) issues.push(code); };
  if (options?.mode !== undefined && options.mode !== "stage" && options.mode !== "r2-model") {
    return { ok: false, mode, issues: ["database_query_failed"] };
  }
  let databasePath: string;
  try {
    const directory = verifyExistingTargetStagingPath(options.stagingDirectory);
    databasePath = path.join(directory, TARGET_STORE_FILENAME);
  } catch {
    return { ok: false, mode, issues: ["unsafe_path"] };
  }
  try {
    // Never follow a database-file symlink (including one targeting legacy data).
    const pathInfo = statSync(databasePath);
    if (lstatSync(databasePath).isSymbolicLink() || !pathInfo.isFile()) {
      return { ok: false, mode, issues: ["missing_database"] };
    }
    if (pinned) {
      const openedInfo = fstatSync(pinned.fd);
      if (!openedInfo.isFile() || pathInfo.dev !== openedInfo.dev || pathInfo.ino !== openedInfo.ino) {
        return { ok: false, mode, issues: ["database_open_failed"] };
      }
    }
  } catch { return { ok: false, mode, issues: ["missing_database"] }; }

  // A read-only SQLite connection can still create -wal/-shm files. Reject WAL
  // databases even after a clean close has removed both sidecars, and reject
  // any existing sidecar before handing the path to SQLite at all.
  try {
    for (const suffix of ["-wal", "-shm"]) {
      try {
        lstatSync(databasePath + suffix);
        return { ok: false, mode, issues: ["database_open_failed"] };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const fd = pinned?.fd ?? openSync(databasePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const header = Buffer.alloc(20);
    let bytesRead: number;
    try { bytesRead = readSync(fd, header, 0, header.length, 0); }
    finally { if (!pinned) closeSync(fd); }
    if (bytesRead !== header.length || header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
        header[18] !== 1 || header[19] !== 1) {
      return { ok: false, mode, issues: ["database_open_failed"] };
    }
  } catch {
    return { ok: false, mode, issues: ["database_open_failed"] };
  }

  let db: DatabaseSync;
  try {
    db = pinned?.db ?? new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return { ok: false, mode, issues: ["database_open_failed"] };
  }
  try {
    const all = (sql: string) => db.prepare(sql).all();
    const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    try {
      if (!matchesCanonicalSchema(db)) fail("schema_invalid");
    } catch { fail("schema_invalid"); }
    try {
      const quick = all("PRAGMA quick_check");
      if (quick.length !== 1 || quick[0].quick_check !== "ok") fail("quick_check_failed");
    } catch { fail("quick_check_failed"); }
    try {
      const integrity = all("PRAGMA integrity_check");
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") fail("integrity_check_failed");
    } catch { fail("integrity_check_failed"); }
    try {
      if (all("PRAGMA foreign_key_check").length !== 0) fail("foreign_key_failed");
    } catch { fail("foreign_key_failed"); }
    try {
      const rows = all("SELECT key, value FROM metadata") as { key: unknown; value: unknown }[];
      const meta = new Map(rows.map(row => [row.key, row.value]));
      const receipts = rows.filter(row => typeof row.key === "string" &&
        row.key.startsWith(TARGET_STAGING_RECEIPT_PREFIX));
      // The only extra metadata entries allowed are strictly validated,
      // content-free, staging-only receipt hashes. Reject unknown metadata,
      // malformed hashes and oversized ledgers; never expose receipt contents.
      const receiptValid = receipts.every(row =>
        typeof row.key === "string" &&
        sha256Hex.test(row.key.slice(TARGET_STAGING_RECEIPT_PREFIX.length)) &&
        typeof row.value === "string" && sha256Hex.test(row.value));
      if (rows.length !== 4 + receipts.length ||
          receipts.length > TARGET_STAGING_MAX_RECEIPTS || !receiptValid ||
          meta.size !== rows.length ||
          !rows.every(row => typeof row.key === "string" &&
            (CONTROL_METADATA_KEYS.has(row.key) ||
              row.key.startsWith(TARGET_STAGING_RECEIPT_PREFIX))) ||
          meta.get("schema_version") !== String(TARGET_STORE_SCHEMA_VERSION) ||
          meta.get("activated") !== "false" || meta.get("write_protocol") !== "per-item-only" ||
          typeof meta.get("restore_generation") !== "string" ||
          !uuid.test(meta.get("restore_generation") as string)) fail("metadata_invalid");
      if (options.expectedRestoreGeneration !== undefined &&
          meta.get("restore_generation") !== options.expectedRestoreGeneration) fail("expected_generation_mismatch");
    } catch { fail("metadata_invalid"); }
    try {
      const owners = all("SELECT w.owner_user_id AS owner FROM workspaces w WHERE w.kind = 'personal'") as { owner: string }[];
      if (owners.length === 0 || owners.length !== new Set(owners.map(row => row.owner)).size ||
          count("SELECT COUNT(*) AS n FROM workspaces WHERE kind NOT IN ('personal','shared') OR kind IS NULL") !== 0 ||
          count("SELECT COUNT(*) AS n FROM identities i WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.kind='personal' AND w.owner_user_id=i.id)") !== 0) {
        fail("personal_workspace_invalid");
      }
      if (options.expectedOwnerUserId !== undefined && !owners.some(row => row.owner === options.expectedOwnerUserId)) {
        fail("expected_owner_mismatch");
      }
      if (count(`SELECT COUNT(*) AS n FROM workspaces w WHERE w.kind='personal' AND NOT EXISTS
        (SELECT 1 FROM areas a WHERE a.workspace_id=w.id AND a.owner_user_id=w.owner_user_id
         AND a.kind='private' AND a.system_key='unassigned')`) !== 0 ||
          count(`SELECT COUNT(*) AS n FROM areas a WHERE a.system_key='unassigned' AND
          (a.kind<>'private' OR NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=a.workspace_id
            AND w.kind='personal' AND w.owner_user_id=a.owner_user_id))`) !== 0 ||
          count(`SELECT COUNT(*) AS n FROM areas a WHERE a.kind='private' AND
          (a.system_key IS NOT NULL AND a.system_key<>'unassigned' OR NOT EXISTS
            (SELECT 1 FROM workspaces w WHERE w.id=a.workspace_id AND w.kind='personal'
              AND w.owner_user_id=a.owner_user_id))`) !== 0) fail("unassigned_area_invalid");
    } catch { fail("database_query_failed"); }
    try {
      if (count(`SELECT COUNT(*) AS n FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
        LEFT JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
        WHERE (t.project_id IS NULL AND t.area_id IS NULL) OR
              (t.project_id IS NOT NULL AND t.area_id IS NOT NULL) OR a.id IS NULL`) !== 0 ||
          count(`SELECT COUNT(*) AS n FROM tasks t LEFT JOIN task_effective_areas e ON e.task_id=t.id
            WHERE e.effective_area_id IS NULL`) !== 0) fail("task_area_invalid");
      if (count(`SELECT COUNT(*) AS n FROM tasks t
        LEFT JOIN projects p ON p.id=t.project_id
        LEFT JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
        WHERE t.assignee_user_id IS NOT NULL AND (a.kind<>'shared' OR a.id IS NULL OR
          NOT EXISTS (SELECT 1 FROM area_members m WHERE m.area_id=a.id
            AND m.user_id=t.assignee_user_id AND m.role IN ('editor','admin')))` ) !== 0) fail("assignee_invalid");
    } catch { fail("database_query_failed"); }
    if (mode === "r2-model") {
      try {
        if (count(`SELECT COUNT(*) AS n FROM workspaces w WHERE w.kind='shared' AND
          (SELECT COUNT(*) FROM areas a WHERE a.workspace_id=w.id AND a.kind='shared')<>1`) !== 0 ||
            count(`SELECT COUNT(*) AS n FROM areas a WHERE a.kind='shared' AND NOT EXISTS
              (SELECT 1 FROM workspaces w WHERE w.id=a.workspace_id AND w.kind='shared'
                AND w.owner_user_id=a.owner_user_id)`) !== 0) fail("shared_mapping_invalid");
        if (count(`SELECT COUNT(*) AS n FROM areas a WHERE a.kind='shared' AND NOT EXISTS
          (SELECT 1 FROM area_members m WHERE m.area_id=a.id AND m.role='admin')`) !== 0) fail("shared_admin_missing");
      } catch { fail("database_query_failed"); }
    }
  } catch {
    fail("database_query_failed");
  } finally {
    if (!pinned) {
      try { db.close(); } catch { fail("database_query_failed"); }
    }
  }
  return { ok: issues.length === 0, mode, issues };
}
