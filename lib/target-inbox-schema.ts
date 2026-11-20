/**
 * C-3a additive triage DDL for a future explicit, pinned v26 -> v27 upgrade.
 *
 * This SQL must be executed in one BEGIN IMMEDIATE transaction together with
 * the version change and the backfill of PREEXISTING rows to "processed".
 * Do not execute this from an HTTP request or a normal app startup.
 * New task INSERTs omit these columns and always default to unprocessed.
 */
// Minimum 90-day retention matches the other staging audit ledgers.
// Older receipts may be compacted only if Undo lineage and live CAS stay safe.
export const TARGET_INBOX_RECEIPT_RETENTION_DAYS = 90;

export const TARGET_INBOX_SCHEMA_SQL = [
  "ALTER TABLE tasks ADD COLUMN triage_state TEXT NOT NULL DEFAULT 'unprocessed' CHECK(triage_state IN ('unprocessed','processed'));",
  "ALTER TABLE tasks ADD COLUMN triaged_at INTEGER DEFAULT NULL CHECK(triaged_at IS NULL OR (typeof(triaged_at)='integer' AND triaged_at>0 AND triaged_at<9007199254740991));",
  "ALTER TABLE tasks ADD COLUMN triage_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(triage_revision)='integer' AND triage_revision>=0 AND triage_revision<9007199254740991);",
  "CREATE INDEX tasks_unprocessed_by_id ON tasks(id) WHERE triage_state='unprocessed';",
  "CREATE TRIGGER task_triage_create_guard BEFORE INSERT ON tasks WHEN NEW.triage_state<>'unprocessed' OR NEW.triaged_at IS NOT NULL OR NEW.triage_revision<>0 BEGIN SELECT RAISE(ABORT,'new tasks must enter Inbox'); END;",
  "CREATE TRIGGER task_triage_revision_guard BEFORE UPDATE OF triage_state,triaged_at,triage_revision ON tasks WHEN (NEW.triage_state IS NOT OLD.triage_state AND NEW.triage_revision<>OLD.triage_revision+1) OR (NEW.triage_state IS OLD.triage_state AND (NEW.triaged_at IS NOT OLD.triaged_at OR NEW.triage_revision IS NOT OLD.triage_revision)) OR (NEW.triage_state='unprocessed' AND NEW.triaged_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'invalid triage transition'); END;",
  "CREATE TRIGGER task_triage_task_revision AFTER UPDATE OF triage_state ON tasks WHEN NEW.triage_state IS NOT OLD.triage_state BEGIN UPDATE tasks SET revision=OLD.revision+1 WHERE id=NEW.id; END;",
  "CREATE TABLE task_triage_receipts (receipt_key TEXT PRIMARY KEY CHECK(length(receipt_key)=64 AND receipt_key NOT GLOB '*[^0-9a-f]*'), request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'), actor_user_id TEXT NOT NULL REFERENCES identities(id), task_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('process','undo')), undo_of_receipt_key TEXT UNIQUE REFERENCES task_triage_receipts(receipt_key), restore_generation TEXT NOT NULL, triage_revision_before INTEGER NOT NULL CHECK(triage_revision_before>=0), triage_revision_after INTEGER NOT NULL CHECK(triage_revision_after=triage_revision_before+1), task_revision_before INTEGER NOT NULL CHECK(task_revision_before>=0), task_revision_after INTEGER NOT NULL CHECK(task_revision_after=task_revision_before+1), committed_at_ms INTEGER NOT NULL CHECK(committed_at_ms>0), CHECK((action='process' AND undo_of_receipt_key IS NULL) OR (action='undo' AND undo_of_receipt_key IS NOT NULL))) WITHOUT ROWID;",
  "CREATE INDEX task_triage_receipts_by_task ON task_triage_receipts(task_id,committed_at_ms);",
  "CREATE TRIGGER task_triage_receipts_immutable_update BEFORE UPDATE ON task_triage_receipts BEGIN SELECT RAISE(ABORT,'triage receipts are immutable'); END;",
  "CREATE TRIGGER task_triage_receipts_guarded_delete BEFORE DELETE ON task_triage_receipts WHEN strftime('%s','now') IS NULL OR OLD.committed_at_ms > (CAST(strftime('%s','now') AS INTEGER)*1000 - " + TARGET_INBOX_RECEIPT_RETENTION_DAYS + "*86400000) BEGIN SELECT RAISE(ABORT,'triage receipt retention window active'); END;",
  "CREATE TRIGGER task_triage_receipts_no_replace BEFORE INSERT ON task_triage_receipts WHEN EXISTS(SELECT 1 FROM task_triage_receipts WHERE receipt_key=NEW.receipt_key OR (NEW.undo_of_receipt_key IS NOT NULL AND undo_of_receipt_key=NEW.undo_of_receipt_key)) BEGIN SELECT RAISE(ABORT,'triage receipt replacement forbidden'); END;",
  "CREATE TRIGGER task_triage_receipts_capacity BEFORE INSERT ON task_triage_receipts WHEN (SELECT COUNT(*) FROM task_triage_receipts)>=4096 BEGIN SELECT RAISE(ABORT,'triage receipt capacity reached'); END;",
].join("\n");

export const TARGET_INBOX_BACKFILL_SQL =
  "UPDATE tasks SET triage_state='processed',triaged_at=NULL,triage_revision=triage_revision+1 WHERE triage_state='unprocessed' AND EXISTS (SELECT 1 FROM metadata WHERE key='schema_version' AND value='26')";
