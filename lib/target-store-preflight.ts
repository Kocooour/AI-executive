/** Explicit, read-only inspection of an existing R1 target staging database. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TARGET_SCHEMA_SQL, TARGET_STORE_FILENAME, TARGET_STORE_SCHEMA_VERSION,
  TARGET_STAGING_AUDIT_MAX_EVENTS, TARGET_STAGING_MAX_RECEIPTS, TARGET_STAGING_SESSION_MAX_ROWS,
  TARGET_STAGING_RECEIPT_PREFIX, TARGET_STAGING_DELETE_RECEIPT_PREFIX,
  TARGET_STAGING_NOTE_RECEIPT_PREFIX, TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX,
  TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX,
  TARGET_STAGING_MAX_TOMBSTONES, TARGET_STAGING_NOTE_CHANGE_MAX_EVENTS, TARGET_STAGING_RESTORE_HISTORY_MAX,
  TARGET_STAGING_SUPERSEDED_SESSIONS_MAX, TARGET_STAGING_MAX_NOTES, verifyExistingTargetStagingPath,
} from "./target-store-bootstrap";

export type TargetPreflightMode = "stage" | "r2-model";
export type TargetPreflightCode =
  | "unsafe_path" | "missing_database" | "database_open_failed" | "database_query_failed"
  | "metadata_invalid" | "schema_invalid" | "expected_owner_mismatch" | "expected_generation_mismatch"
  | "quick_check_failed" | "integrity_check_failed" | "foreign_key_failed"
  | "personal_workspace_invalid" | "unassigned_area_invalid" | "task_area_invalid"
  | "audit_invalid" | "session_invalid" | "tombstone_invalid"
  | "change_log_invalid" | "membership_log_invalid" | "change_log_floor_invalid"
  | "assignee_invalid" | "shared_mapping_invalid" | "shared_admin_missing"
  | "restore_history_invalid" | "note_invalid" | "note_sync_journal_invalid";

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
  "schema_version", "activated", "write_protocol", "restore_generation", "change_log_floor",
  "anchor_seq",
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

/**
 * R2c.4b: the restore history must be exactly ONE chain. Walk the predecessors from the current
 * generation through the rows (generation -> previous_generation); a cycle (also a self-loop) fails,
 * EVERY row must be reached exactly once (no detached chain or cycle), previous generations are
 * unique, and the walk ends at a generation which is not itself a row's generation (the original).
 * An empty history is the original generation alone.
 */
export function restoreHistoryIsOneChain(
  history: readonly { generation: unknown; previous_generation: unknown }[], current: string,
): boolean {
  if (history.length === 0) return true;
  const byGeneration = new Map<unknown, unknown>();
  const previous = new Set<unknown>();
  for (const row of history) {
    if (byGeneration.has(row.generation) || previous.has(row.previous_generation)) return false;
    byGeneration.set(row.generation, row.previous_generation);
    previous.add(row.previous_generation);
  }
  const seen = new Set<unknown>();
  let cursor: unknown = current;
  while (byGeneration.has(cursor)) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = byGeneration.get(cursor);
  }
  return seen.size === history.length && !byGeneration.has(cursor);
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
    const count = (sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
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
    // Notes are staging-only until a validated command/HTTP/sync contract exists.
    // Recheck row invariants even when a writer disabled CHECK/FK enforcement.
    try {
      if (count("SELECT COUNT(*) AS n FROM notes") > TARGET_STAGING_MAX_NOTES ||
          count(`SELECT COUNT(*) AS n FROM notes n
            LEFT JOIN projects p ON p.id=n.project_id
            LEFT JOIN areas a ON a.id=n.area_id
            WHERE (n.project_id IS NULL AND n.area_id IS NULL)
               OR (n.project_id IS NOT NULL AND (n.area_id IS NOT NULL OR p.id IS NULL))
               OR (n.project_id IS NULL AND a.id IS NULL)
               OR typeof(n.id)<>'text' OR n.id='' OR n.id<>trim(n.id)
               OR n.id IN ('.','..') OR length(CAST(n.id AS BLOB))>512
               OR instr(n.id,char(0))>0
               OR n.id GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
               OR typeof(n.title)<>'text' OR length(trim(n.title))=0
               OR length(CAST(n.title AS BLOB))>4096 OR typeof(n.body)<>'text'
               OR length(CAST(n.body AS BLOB))>131072 OR typeof(n.revision)<>'integer'
               OR n.revision<0 OR n.revision>=9007199254740991`) !== 0)
        fail("note_invalid");
    } catch { fail("note_invalid"); }
    // A tombstone cannot coexist with a live note. The marker keeps only
    // immutable ID/Area/parent/revision/time, not deleted title or body.
    // Recheck even when SQLite CHECK/FK enforcement was bypassed by a writer.
    try {
      if (count("SELECT COUNT(*) AS n FROM note_tombstones") > TARGET_STAGING_MAX_TOMBSTONES ||
          count(`SELECT COUNT(*) AS n FROM note_tombstones t
            LEFT JOIN areas a ON a.id=t.area_id
            LEFT JOIN notes n ON n.id=t.id
            WHERE n.id IS NOT NULL OR a.id IS NULL
              OR typeof(t.id)<>'text' OR t.id='' OR t.id<>trim(t.id)
              OR t.id IN ('.','..') OR length(CAST(t.id AS BLOB))>512
              OR instr(t.id,char(0))>0
              OR t.id GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
              OR typeof(t.area_id)<>'text'
              OR (t.project_id IS NOT NULL AND
                (typeof(t.project_id)<>'text' OR t.project_id='' OR length(CAST(t.project_id AS BLOB))>512))
              OR typeof(t.revision)<>'integer' OR t.revision<=0 OR t.revision>=9007199254740991
              OR typeof(t.deleted_at_ms)<>'integer' OR t.deleted_at_ms<=0`) !== 0)
        fail("tombstone_invalid");
    } catch { fail("tombstone_invalid"); }
    try {
      const rows = all("SELECT key, value FROM metadata") as { key: unknown; value: unknown }[];
      const meta = new Map(rows.map(row => [row.key, row.value]));
      const receipts = rows.filter(row => typeof row.key === "string" &&
        row.key.startsWith(TARGET_STAGING_RECEIPT_PREFIX));
      const deleteReceipts = rows.filter(row => typeof row.key === "string" &&
        row.key.startsWith(TARGET_STAGING_DELETE_RECEIPT_PREFIX));
      const noteReceipts = rows.filter(row => typeof row.key === "string" &&
        row.key.startsWith(TARGET_STAGING_NOTE_RECEIPT_PREFIX));
      const noteDeleteReceipts = rows.filter(row => typeof row.key === "string" &&
        row.key.startsWith(TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX));
      const lifecycleReceipts = rows.filter(row => typeof row.key === "string" &&
        row.key.startsWith(TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX));
      // The only extra metadata entries allowed are strictly validated,
      // content-free, staging-only receipt hashes (title, delete and note
      // namespaces, each capped separately). Reject unknown metadata,
      // malformed hashes and oversized ledgers; never expose receipt contents.
      const receiptValid = (list: typeof rows, prefix: string) => list.every(row =>
        typeof row.key === "string" &&
        sha256Hex.test(row.key.slice(prefix.length)) &&
        typeof row.value === "string" && sha256Hex.test(row.value));
      if (rows.length !== 6 + receipts.length + deleteReceipts.length + noteReceipts.length +
            noteDeleteReceipts.length + lifecycleReceipts.length ||
          receipts.length > TARGET_STAGING_MAX_RECEIPTS ||
          deleteReceipts.length > TARGET_STAGING_MAX_RECEIPTS ||
          noteReceipts.length > TARGET_STAGING_MAX_RECEIPTS ||
          noteDeleteReceipts.length > TARGET_STAGING_MAX_RECEIPTS ||
          lifecycleReceipts.length > TARGET_STAGING_MAX_RECEIPTS ||
          !receiptValid(receipts, TARGET_STAGING_RECEIPT_PREFIX) ||
          !receiptValid(deleteReceipts, TARGET_STAGING_DELETE_RECEIPT_PREFIX) ||
          !receiptValid(noteReceipts, TARGET_STAGING_NOTE_RECEIPT_PREFIX) ||
          !receiptValid(noteDeleteReceipts, TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX) ||
          !receiptValid(lifecycleReceipts, TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX) ||
          meta.size !== rows.length ||
          !rows.every(row => typeof row.key === "string" &&
            (CONTROL_METADATA_KEYS.has(row.key) ||
              row.key.startsWith(TARGET_STAGING_RECEIPT_PREFIX) ||
              row.key.startsWith(TARGET_STAGING_DELETE_RECEIPT_PREFIX) ||
              row.key.startsWith(TARGET_STAGING_NOTE_RECEIPT_PREFIX) ||
              row.key.startsWith(TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX) ||
              row.key.startsWith(TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX))) ||
          meta.get("schema_version") !== String(TARGET_STORE_SCHEMA_VERSION) ||
          meta.get("activated") !== "false" || meta.get("write_protocol") !== "per-item-only" ||
          typeof meta.get("anchor_seq") !== "string" ||
          !/^(0|[1-9][0-9]{0,14})$/.test(meta.get("anchor_seq") as string) ||
          typeof meta.get("restore_generation") !== "string" ||
          !uuid.test(meta.get("restore_generation") as string)) fail("metadata_invalid");
      if (options.expectedRestoreGeneration !== undefined &&
          meta.get("restore_generation") !== options.expectedRestoreGeneration) fail("expected_generation_mismatch");
      // R2c.4b: a restore replaces restore_generation and leaves the earlier ones in the append-only
      // history, so audit rows written under an earlier generation of THIS store stay valid. The
      // history must be one chain which ends at the current generation, and every superseded
      // session must name a generation of that history. Audit rows of any other generation fail.
      const history = all("SELECT generation, previous_generation FROM restore_generations") as
        { generation: string; previous_generation: string }[];
      const current = meta.get("restore_generation");
      if (history.length > TARGET_STAGING_RESTORE_HISTORY_MAX ||
          !restoreHistoryIsOneChain(history, current as string) ||
          count("SELECT COUNT(*) AS n FROM restore_superseded_sessions") > TARGET_STAGING_SUPERSEDED_SESSIONS_MAX ||
          count(`SELECT COUNT(*) AS n FROM restore_superseded_sessions s LEFT JOIN restore_generations g
            ON g.generation=s.restore_generation WHERE g.generation IS NULL`) !== 0) fail("restore_history_invalid");
      const allowedGenerations = new Set<unknown>([current, ...history.map(row => row.previous_generation)]);
      const audit = all("SELECT receipt_key, expected_revision, restore_generation FROM task_title_audit") as
        { receipt_key: unknown; expected_revision: unknown; restore_generation: unknown }[];
      if (audit.length > TARGET_STAGING_AUDIT_MAX_EVENTS ||
          audit.some(row => typeof row.receipt_key !== "string" ||
            !row.receipt_key.startsWith(TARGET_STAGING_RECEIPT_PREFIX) ||
            !sha256Hex.test(row.receipt_key.slice(TARGET_STAGING_RECEIPT_PREFIX.length)) ||
            typeof row.expected_revision !== "string" || !sha256Hex.test(row.expected_revision) ||
            !allowedGenerations.has(row.restore_generation) ||
            !meta.has(row.receipt_key))) fail("audit_invalid");
      // R2c.1 delete audit: bounded, content-free, backed by a delete receipt and
      // by the tombstone (same Area, revision and change sequence) it describes.
      const deleteAudit = all("SELECT receipt_key, expected_revision, restore_generation FROM task_delete_audit") as
        { receipt_key: unknown; expected_revision: unknown; restore_generation: unknown }[];
      if (deleteAudit.length > TARGET_STAGING_AUDIT_MAX_EVENTS ||
          deleteAudit.some(row => typeof row.receipt_key !== "string" ||
            !row.receipt_key.startsWith(TARGET_STAGING_DELETE_RECEIPT_PREFIX) ||
            !sha256Hex.test(row.receipt_key.slice(TARGET_STAGING_DELETE_RECEIPT_PREFIX.length)) ||
            typeof row.expected_revision !== "string" || !sha256Hex.test(row.expected_revision) ||
            !allowedGenerations.has(row.restore_generation) ||
            !meta.has(row.receipt_key)) ||
          count(`SELECT COUNT(*) AS n FROM task_delete_audit a LEFT JOIN task_tombstones ts ON ts.id=a.task_id
            WHERE ts.id IS NULL OR ts.area_id<>a.area_id OR ts.revision<>a.tombstone_revision
              OR ts.change_seq<>a.change_seq`) !== 0) fail("audit_invalid");
      // Note edits are one receipt + one content-free immutable audit event.
      const noteAudit = all("SELECT receipt_key, expected_revision, restore_generation FROM note_edit_audit") as
        { receipt_key: unknown; expected_revision: unknown; restore_generation: unknown }[];
      if (noteAudit.length > TARGET_STAGING_AUDIT_MAX_EVENTS ||
          noteAudit.some(row => typeof row.receipt_key !== "string" ||
            !row.receipt_key.startsWith(TARGET_STAGING_NOTE_RECEIPT_PREFIX) ||
            !sha256Hex.test(row.receipt_key.slice(TARGET_STAGING_NOTE_RECEIPT_PREFIX.length)) ||
            typeof row.expected_revision !== "string" || !sha256Hex.test(row.expected_revision) ||
            !allowedGenerations.has(row.restore_generation) || !meta.has(row.receipt_key)) ||
          // v15 audit history survives note deletion, but must still refer to
          // a live note or immutable tombstone. An audit for a future revision
          // would otherwise be accepted after removing the live-note FK.
          count(`SELECT COUNT(*) AS n FROM note_edit_audit a
            LEFT JOIN notes n ON n.id=a.note_id
            LEFT JOIN note_tombstones t ON t.id=a.note_id
            WHERE (n.id IS NULL AND t.id IS NULL)
              OR (n.id IS NOT NULL AND a.revision_after>n.revision)
              OR (t.id IS NOT NULL AND a.revision_after>=t.revision)`) !== 0 ||
          count(`SELECT COUNT(*) AS n FROM metadata m WHERE substr(m.key,1,?)=?
            AND NOT EXISTS(SELECT 1 FROM note_edit_audit a WHERE a.receipt_key=m.key)`,
            TARGET_STAGING_NOTE_RECEIPT_PREFIX.length, TARGET_STAGING_NOTE_RECEIPT_PREFIX) !== 0) fail("audit_invalid");
      // Delete audit must be bound 1:1 to the actor's receipt and the exact
      // immutable note tombstone, never to a resurrected or foreign parent.
      const noteDeleteAudit = all("SELECT receipt_key, expected_revision, restore_generation FROM note_delete_audit") as
        { receipt_key: unknown; expected_revision: unknown; restore_generation: unknown }[];
      if (noteDeleteAudit.length > TARGET_STAGING_AUDIT_MAX_EVENTS ||
          noteDeleteAudit.some(row => typeof row.receipt_key !== "string" ||
            !row.receipt_key.startsWith(TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX) ||
            !sha256Hex.test(row.receipt_key.slice(TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX.length)) ||
            typeof row.expected_revision !== "string" || !sha256Hex.test(row.expected_revision) ||
            !allowedGenerations.has(row.restore_generation) || !meta.has(row.receipt_key)) ||
          count(`SELECT COUNT(*) AS n FROM note_delete_audit a
            LEFT JOIN note_tombstones t ON t.id=a.note_id
            WHERE t.id IS NULL OR t.area_id<>a.area_id
              OR t.project_id IS NOT a.project_id
              OR t.revision<>a.tombstone_revision
              OR t.deleted_at_ms<>a.committed_at_ms
              OR typeof(a.note_id)<>'text' OR a.note_id=''
              OR typeof(a.actor_user_id)<>'text'
              OR typeof(a.policy_revision)<>'integer' OR a.policy_revision<0
              OR typeof(a.revision_before)<>'integer' OR a.revision_before<0
              OR typeof(a.tombstone_revision)<>'integer'
              OR a.tombstone_revision<>a.revision_before+1
              OR typeof(a.committed_at_ms)<>'integer' OR a.committed_at_ms<=0`) !== 0 ||
          count(`SELECT COUNT(*) AS n FROM metadata m WHERE substr(m.key,1,?)=?
            AND NOT EXISTS(SELECT 1 FROM note_delete_audit a WHERE a.receipt_key=m.key)`,
            TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX.length,
            TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX) !== 0 ||
          // A raw SQL tombstone+DELETE with no audit or receipt must not become
          // a trusted note deletion. This reverse check is essential: the above
          // checks only audit -> tombstone, not tombstone -> audit.
          count(`SELECT COUNT(*) AS n FROM note_tombstones t
            LEFT JOIN note_delete_audit a ON a.note_id=t.id
            WHERE a.id IS NULL`) !== 0) fail("audit_invalid");
      // Delete receipts are 1:1 with delete audit rows: a raw receipt for a task
      // that was never deleted would otherwise replay as "committed".
      if (count(`SELECT COUNT(*) AS n FROM metadata m WHERE substr(m.key,1,?)=?
        AND NOT EXISTS (SELECT 1 FROM task_delete_audit a WHERE a.receipt_key=m.key)`,
        TARGET_STAGING_DELETE_RECEIPT_PREFIX.length, TARGET_STAGING_DELETE_RECEIPT_PREFIX) !== 0) fail("audit_invalid");
    } catch { fail("metadata_invalid"); }

    // R2d.2c.2g.2b.1: the note-only journal must have a bijection with
    // signed audit-backed note mutations. Never trust a raw inserted event.
    // There is deliberately no HTTP or client consumption of this table.
    try {
      if (count(`SELECT COUNT(*) AS n FROM areas a WHERE
            typeof(a.note_sync_revision)<>'integer' OR a.note_sync_revision<0
            OR a.note_sync_revision>=9007199254740991
            OR a.note_sync_revision <
              (SELECT COUNT(*) FROM note_change_journal j WHERE j.area_id=a.id)`) !== 0 ||
          count("SELECT COUNT(*) AS n FROM note_change_journal") > TARGET_STAGING_NOTE_CHANGE_MAX_EVENTS ||
          count(`SELECT COUNT(*) AS n FROM note_change_journal j
            LEFT JOIN note_edit_audit e ON j.kind='edit' AND e.receipt_key=j.receipt_key
            LEFT JOIN note_delete_audit d ON j.kind='delete' AND d.receipt_key=j.receipt_key
            WHERE typeof(j.seq)<>'integer' OR j.seq<=0 OR j.seq>=9007199254740991
              OR j.kind NOT IN ('edit','delete','upsert','leave')
              OR (SELECT COUNT(*) FROM note_change_journal x
                WHERE x.area_id=j.area_id AND x.seq<=j.seq)<>j.seq OR j.revision<0
              OR typeof(j.committed_at_ms)<>'integer' OR j.committed_at_ms<=0
              OR (j.kind='edit' AND
                (e.id IS NULL OR j.note_id IS NOT e.note_id
                  OR j.area_id IS NOT e.area_id OR j.project_id IS NOT e.project_id
                  OR j.actor_user_id IS NOT e.actor_user_id
                  OR j.policy_revision IS NOT e.policy_revision
                  OR j.revision IS NOT e.revision_after
                  OR j.committed_at_ms IS NOT e.committed_at_ms))
              OR (j.kind='delete' AND
                (d.id IS NULL OR j.note_id IS NOT d.note_id
                  OR j.area_id IS NOT d.area_id OR j.project_id IS NOT d.project_id
                  OR j.actor_user_id IS NOT d.actor_user_id
                  OR j.policy_revision IS NOT d.policy_revision
                  OR j.revision IS NOT d.tombstone_revision
                  OR j.committed_at_ms IS NOT d.committed_at_ms))`) !== 0 ||
          count(`SELECT COUNT(*) AS n FROM note_edit_audit e
            LEFT JOIN note_change_journal j
              ON j.receipt_key=e.receipt_key AND j.kind='edit'
            WHERE j.seq IS NULL`) !== 0 ||
          count(`SELECT COUNT(*) AS n FROM note_delete_audit d
            LEFT JOIN note_change_journal j
              ON j.receipt_key=d.receipt_key AND j.kind='delete'
            WHERE j.seq IS NULL`) !== 0) fail("note_sync_journal_invalid");
    } catch { fail("note_sync_journal_invalid"); }
    try {
      // R2c.1 tombstones and change log. Every check is a primary-key or
      // partial-index lookup bounded by the staging tombstone cap, never a
      // scan of the whole log. A tombstone must be backed by exactly its own
      // 'tombstone' log entry (same sequence, ID, Area and revision), no live
      // task/project may carry a tombstoned ID, and the log may not hold
      // 'tombstone' entries which no tombstone explains.
      const tombstoneChecks = (kind: "task" | "project") => {
        const table = kind === "task" ? "task_tombstones" : "project_tombstones";
        const live = kind === "task" ? "tasks" : "projects";
        return count(`SELECT COUNT(*) AS n FROM ${table}`) > TARGET_STAGING_MAX_TOMBSTONES ||
          count(`SELECT COUNT(*) AS n FROM ${table} ts LEFT JOIN change_log c ON c.seq=ts.change_seq
            WHERE c.seq IS NULL OR c.entity_kind<>'${kind}' OR c.op<>'tombstone'
              OR c.entity_id<>ts.id OR c.area_id<>ts.area_id OR c.revision<>ts.revision`) !== 0 ||
          count(`SELECT COUNT(*) AS n FROM ${table} ts JOIN ${live} l ON l.id=ts.id`) !== 0;
      };
      if (tombstoneChecks("task") || tombstoneChecks("project") ||
          count("SELECT COUNT(*) AS n FROM change_log WHERE op='tombstone'") !==
            count("SELECT COUNT(*) AS n FROM task_tombstones") +
            count("SELECT COUNT(*) AS n FROM project_tombstones")) fail("tombstone_invalid");
    } catch { fail("tombstone_invalid"); }
    // R2c.2b compaction floor: a canonical integer within [0, MAX(seq)], and a
    // consistent compaction: no row at or below it is superseded by a later row of
    // its own key that is also at or below it (rows == distinct keys below the floor).
    let floor = 0;
    try {
      const raw = (db.prepare("SELECT value FROM metadata WHERE key='change_log_floor'")
        .get() as { value: unknown } | undefined)?.value;
      const max = count("SELECT COALESCE(MAX(seq),0) AS n FROM change_log");
      if (typeof raw !== "string" || !/^(0|[1-9][0-9]{0,14})$/.test(raw) || Number(raw) > max) {
        fail("change_log_floor_invalid");
      } else {
        floor = Number(raw);
        if (count("SELECT COUNT(*) AS n FROM change_log WHERE seq<=?", floor) !==
            count(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM change_log WHERE seq<=?
              GROUP BY entity_kind, entity_id, member_user_id)`, floor)) fail("change_log_floor_invalid");
      }
    } catch { fail("change_log_floor_invalid"); }
    try {
      // R2c.1 change_log reconciliation with live state (set-based, index-driven).
      // 'leave' rows are ignored: only the latest upsert/tombstone of an entity
      // is authoritative, whatever order SQLite fired the move triggers in. A live
      // task/project must end in an 'upsert' matching its revision and effective
      // Area; every entity ID appearing anywhere in the log (even only as 'leave')
      // must be live or end in the 'tombstone' its tombstone row names.
      const reconcile = (kind: "task" | "project") => {
        const live = kind === "task" ? "tasks" : "projects";
        const tomb = kind === "task" ? "task_tombstones" : "project_tombstones";
        const area = kind === "task" ? "COALESCE(l.area_id, p.area_id)" : "l.area_id";
        const join = kind === "task" ? "LEFT JOIN projects p ON p.id=l.project_id" : "";
        const latest = `(SELECT MAX(x.seq) FROM change_log x WHERE x.entity_kind='${kind}'
          AND x.entity_id=%ID% AND x.member_user_id IS NULL AND x.op IN ('upsert','tombstone'))`;
        return count(`SELECT COUNT(*) AS n FROM ${live} l ${join} WHERE NOT EXISTS (
          SELECT 1 FROM change_log c WHERE c.entity_kind='${kind}' AND c.entity_id=l.id
            AND c.op='upsert' AND c.revision=l.revision AND c.area_id=${area}
            AND c.seq=${latest.replace("%ID%", "l.id")})`) !== 0 ||
          count(`SELECT COUNT(*) AS n FROM (SELECT entity_id AS id, MAX(seq) AS last FROM change_log
            WHERE entity_kind='${kind}' GROUP BY entity_id) g
            WHERE NOT EXISTS (SELECT 1 FROM ${live} l WHERE l.id=g.id)
              AND NOT EXISTS (SELECT 1 FROM ${tomb} ts WHERE ts.id=g.id AND ts.change_seq=g.last)`) !== 0;
      };
      if (reconcile("task") || reconcile("project")) fail("change_log_invalid");
    } catch { fail("change_log_invalid"); }
    try {
      // Membership, one aggregate per (Area, user) so the cost stays linear in
      // the log (a correlated subquery per row was quadratic in membership churn):
      // the latest entry is the live row's state (add/role with its role) or a
      // removal when no row exists, and the first removal follows a first
      // add/role entry (unless that removal is the compacted last row at or below the
      // floor, whose earlier add was legitimately compacted away). This does not
      // enforce strict add/remove alternation.
      const perMember = `(SELECT entity_id AS area, member_user_id AS who, MAX(seq) AS last,
          MIN(CASE WHEN op IN ('member_add','member_role') THEN seq END) AS first_grant,
          MIN(CASE WHEN op='member_remove' THEN seq END) AS first_remove
        FROM change_log WHERE entity_kind='membership' GROUP BY entity_id, member_user_id)`;
      if (count(`SELECT COUNT(*) AS n FROM area_members m
            LEFT JOIN ${perMember} g ON g.area=m.area_id AND g.who=m.user_id
            LEFT JOIN change_log c ON c.seq=g.last
            WHERE c.seq IS NULL OR c.op NOT IN ('member_add','member_role') OR c.member_role IS NOT m.role`) !== 0 ||
          count(`SELECT COUNT(*) AS n FROM ${perMember} g JOIN change_log c ON c.seq=g.last
            WHERE c.op<>'member_remove' AND NOT EXISTS (
              SELECT 1 FROM area_members a WHERE a.area_id=g.area AND a.user_id=g.who)`) !== 0 ||
          count(`SELECT COUNT(*) AS n FROM ${perMember} g
            WHERE g.first_remove IS NOT NULL AND g.first_remove > ${floor}
              AND (g.first_grant IS NULL OR g.first_grant > g.first_remove)`) !== 0) {
        fail("membership_log_invalid");
      }
    } catch { fail("membership_log_invalid"); }
    try {
      // R2-ID.2a membership ledger: bounded, same restore generation, and every
      // audited change must be backed by an 'applied' receipt.
      const generation = (db.prepare("SELECT value FROM metadata WHERE key='restore_generation'")
        .get() as { value: string } | undefined)?.value;
      if (typeof generation !== "string" ||
          count("SELECT COUNT(*) AS n FROM area_membership_receipts") > TARGET_STAGING_MAX_RECEIPTS ||
          count("SELECT COUNT(*) AS n FROM area_membership_audit") > TARGET_STAGING_AUDIT_MAX_EVENTS ||
          Number((db.prepare(`SELECT COUNT(*) AS n FROM area_membership_audit a
            LEFT JOIN area_membership_receipts r ON r.receipt_key=a.receipt_key
            WHERE r.receipt_key IS NULL OR r.outcome<>'applied' OR a.restore_generation NOT IN (
              SELECT ? UNION SELECT previous_generation FROM restore_generations)`)
            .get(generation) as { n: number }).n) !== 0) fail("audit_invalid");
    } catch { fail("audit_invalid"); }
    try {
      // Durable sessions hold only hashes (enforced by DDL CHECKs). A row whose
      // issue-time epoch exceeds its identity's epoch cannot have been issued
      // by the supported library and is treated as tampering.
      if (count("SELECT COUNT(*) AS n FROM staging_sessions") > TARGET_STAGING_SESSION_MAX_ROWS ||
          count(`SELECT COUNT(*) AS n FROM staging_sessions s LEFT JOIN identities i ON i.id=s.user_id
            WHERE i.id IS NULL OR s.revocation_epoch > i.revocation_epoch`) !== 0) fail("session_invalid");
    } catch { fail("session_invalid"); }
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
