/**
 * C-3a additive triage DDL for a future explicit, pinned v26 -> v27 upgrade.
 *
 * This SQL must be executed in one BEGIN IMMEDIATE transaction together with
 * the version change and the backfill of PREEXISTING rows to "processed".
 * Do not execute this from an HTTP request or a normal app startup.
 * New task INSERTs omit these columns and always default to unprocessed.
 */
export const TARGET_INBOX_SCHEMA_SQL = [
  "ALTER TABLE tasks ADD COLUMN triage_state TEXT NOT NULL DEFAULT 'unprocessed' CHECK(triage_state IN ('unprocessed','processed'));",
  "ALTER TABLE tasks ADD COLUMN triaged_at INTEGER DEFAULT NULL CHECK(triaged_at IS NULL OR (typeof(triaged_at)='integer' AND triaged_at>0 AND triaged_at<9007199254740991));",
  "ALTER TABLE tasks ADD COLUMN triage_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(triage_revision)='integer' AND triage_revision>=0 AND triage_revision<9007199254740991);",
  "CREATE INDEX tasks_unprocessed_by_id ON tasks(id) WHERE triage_state='unprocessed';",
  "CREATE TRIGGER task_triage_create_guard BEFORE INSERT ON tasks WHEN NEW.triage_state<>'unprocessed' OR NEW.triaged_at IS NOT NULL OR NEW.triage_revision<>0 BEGIN SELECT RAISE(ABORT,'new tasks must enter Inbox'); END;",
  "CREATE TRIGGER task_triage_revision_guard BEFORE UPDATE OF triage_state,triaged_at,triage_revision ON tasks WHEN (NEW.triage_state IS NOT OLD.triage_state AND NEW.triage_revision<>OLD.triage_revision+1) OR (NEW.triage_state IS OLD.triage_state AND (NEW.triaged_at IS NOT OLD.triaged_at OR NEW.triage_revision IS NOT OLD.triage_revision)) OR (NEW.triage_state='unprocessed' AND NEW.triaged_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'invalid triage transition'); END;",
  "CREATE TRIGGER task_triage_task_revision AFTER UPDATE OF triage_state ON tasks WHEN NEW.triage_state IS NOT OLD.triage_state BEGIN UPDATE tasks SET revision=OLD.revision+1 WHERE id=NEW.id; END;",
].join("\n");

export const TARGET_INBOX_BACKFILL_SQL =
  "UPDATE tasks SET triage_state='processed',triaged_at=NULL,triage_revision=triage_revision+1 WHERE triage_state='unprocessed' AND EXISTS (SELECT 1 FROM metadata WHERE key='schema_version' AND value='26')";
