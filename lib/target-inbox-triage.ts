/** C-3a: additive target-only Inbox triage model.
 * Installation must run on a preflighted, pinned target SQLite connection in a
 * caller-owned BEGIN IMMEDIATE transaction. Never run against the legacy store.
 * Historical target tasks are backfilled as processed without fabricating
 * actor commands, timestamps or notification events.
 */
import type {DatabaseSync} from "node:sqlite";

export const TARGET_INBOX_TRIAGE_SCHEMA_VERSION = 27;
export const TARGET_INBOX_TRIAGE_SQL = `
CREATE TABLE task_triage (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  triage_state TEXT NOT NULL CHECK(triage_state IN ('unprocessed','processed')),
  triaged_at_ms INTEGER DEFAULT NULL CHECK(
    triaged_at_ms IS NULL OR (typeof(triaged_at_ms)='integer' AND
      triaged_at_ms>0 AND triaged_at_ms<9007199254740991)),
  triage_revision INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(triage_revision)='integer' AND
    triage_revision>=0 AND triage_revision<9007199254740991),
  CHECK(triage_state='processed' OR triaged_at_ms IS NULL)
) WITHOUT ROWID;
CREATE INDEX task_triage_unprocessed ON task_triage(task_id)
  WHERE triage_state='unprocessed';
-- Every subsequently created target task goes to the Inbox, including project
-- tasks and tasks whose When/Area is already set at creation time.
CREATE TRIGGER task_triage_on_create AFTER INSERT ON tasks
BEGIN
  INSERT INTO task_triage(task_id,triage_state,triaged_at_ms,triage_revision)
    VALUES(NEW.id,'unprocessed',NULL,0);
END;
-- Triage is independent of completion, project, Area, assignee and When.
-- Every explicit state transition increments its own revision, not the task
-- revision or actor-private plan revision.
CREATE TRIGGER task_triage_bump AFTER UPDATE OF triage_state,triaged_at_ms ON task_triage
WHEN NEW.triage_state IS NOT OLD.triage_state OR
  NEW.triaged_at_ms IS NOT OLD.triaged_at_ms
BEGIN
  UPDATE task_triage SET triage_revision=OLD.triage_revision+1
    WHERE task_id=NEW.task_id;
END;
CREATE TRIGGER task_triage_revision_guard BEFORE UPDATE OF triage_revision ON task_triage
WHEN NEW.triage_revision<>OLD.triage_revision+1
BEGIN SELECT RAISE(ABORT,'triage revision must increment by one'); END;
CREATE TRIGGER task_triage_replace_guard BEFORE INSERT ON task_triage
WHEN EXISTS(SELECT 1 FROM task_triage WHERE task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT,'triage replacement forbidden'); END;
-- A task's terminal deletion cascades the triage row. A caller cannot remove
-- the triage record of a live task to hide it from the Inbox.
CREATE TRIGGER task_triage_delete_guard BEFORE DELETE ON task_triage
WHEN EXISTS(SELECT 1 FROM tasks WHERE id=OLD.task_id)
BEGIN SELECT RAISE(ABORT,'cannot delete triage for a live task'); END;
`;

/** Pure canonical membership shared by row and count checks. Completed tasks
 * remain unprocessed until an explicit Process; tombstones never contribute. */
export function inboxMembership(input:{
  authorized:boolean; exists:boolean; tombstoned:boolean;
  triageState:"unprocessed"|"processed"; completion:"open"|"completed";
}):boolean{
  return input.authorized && input.exists && !input.tombstoned &&
    input.triageState==="unprocessed";
}

/** Structural upgrade only. The caller must hold the isolated target store's
 * journal/witness and canonical file preflight protections. No auto-upgrade
 * occurs at app startup, and no legacy store is ever touched. */
export function migrateTargetInboxTriageInTransaction(db:DatabaseSync):
  "applied"|"already_applied" {
  if(!db.isTransaction)throw new Error("C-3a requires a pinned BEGIN IMMEDIATE transaction");
  const row=db.prepare("SELECT value FROM metadata WHERE key='schema_version'")
    .get() as {value:string}|undefined;
  if(row?.value==="27"){
    const present=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='task_triage'")
      .get();
    if(!present)throw new Error("C-3a schema mismatch");
    return "already_applied";
  }
  if(row?.value!=="26")throw new Error("C-3a requires preflighted v26 target schema");
  db.exec(TARGET_INBOX_TRIAGE_SQL);
  // Migration is NOT user triage. A NULL timestamp is intentional and legal.
  db.exec("INSERT INTO task_triage(task_id,triage_state,triaged_at_ms,triage_revision) SELECT id,'processed',NULL,0 FROM tasks");
  db.prepare("UPDATE metadata SET value='27' WHERE key='schema_version' AND value='26'").run();
  return "applied";
}
