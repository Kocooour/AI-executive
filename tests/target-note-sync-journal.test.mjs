import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  TARGET_SCHEMA_SQL, TARGET_STORE_SCHEMA_VERSION, TARGET_STAGING_NOTE_CHANGE_MAX_EVENTS,
} from "../lib/target-store-bootstrap.ts";

/** All events in this fixture are written by SQLite audit triggers, never by a client. */
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(TARGET_SCHEMA_SQL);
  db.prepare("INSERT INTO identities(id) VALUES ('alice')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('personal','personal','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('private','Private','private','personal','alice')").run();
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('one','private','Classified','Top secret')").run();
  return db;
}
function edit(db, receipt = "edit-1", timestamp = 1000) {
  db.prepare("UPDATE notes SET body='Revised secret' WHERE id='one'").run();
  db.prepare(`INSERT INTO note_edit_audit
    (receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,
     revision_before,revision_after,expected_revision,restore_generation,committed_at_ms)
    VALUES (?,'alice','one',NULL,'private',0,0,1,?,'00000000-0000-4000-8000-000000000001',?)`)
    .run(receipt, "a".repeat(64), timestamp);
}
function deletion(db, timestamp = 2000) {
  db.prepare(`INSERT INTO note_tombstones(id,area_id,project_id,revision,deleted_at_ms)
    VALUES ('one','private',NULL,2,?)`).run(timestamp);
  db.prepare("DELETE FROM notes WHERE id='one'").run();
  db.prepare(`INSERT INTO note_delete_audit
    (receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,
     revision_before,tombstone_revision,expected_revision,restore_generation,committed_at_ms)
    VALUES ('delete-1','alice','one',NULL,'private',0,1,2,?,
      '00000000-0000-4000-8000-000000000001',?)`)
    .run("b".repeat(64), timestamp);
}

test("staging v19+ retains monotonic content-free edit and delete events", () => {
  const db = fixture();
  try {
    assert.ok(TARGET_STORE_SCHEMA_VERSION >= 19, "requires staging schema v19+");
    assert.equal(TARGET_STAGING_NOTE_CHANGE_MAX_EVENTS, 8192);
    edit(db);
    deletion(db);
    const events = db.prepare("SELECT * FROM note_change_journal ORDER BY seq").all();
    assert.deepEqual(events.map(e => [e.seq,e.kind,e.receipt_key,e.note_id,e.area_id,
      e.project_id,e.revision,e.committed_at_ms]), [
      [1,"edit","edit-1","one","private",null,1,1000],
      [2,"delete","delete-1","one","private",null,2,2000],
    ]);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    for (const secret of ["Classified", "Top secret", "Revised secret"])
      assert.equal(JSON.stringify(events).includes(secret), false);
    assert.throws(() => db.prepare("DELETE FROM note_change_journal WHERE seq=1").run(),
      /note change journal permanent/);
    assert.throws(() => db.prepare("UPDATE note_change_journal SET revision=99 WHERE seq=1").run(),
      /note change journal immutable/);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO note_change_journal SELECT * FROM note_change_journal WHERE seq=1").run());
    assert.throws(() => db.prepare("DELETE FROM note_edit_audit WHERE receipt_key='edit-1'").run());
  } finally { db.close(); }
});

test("rolled-back note edit and audit never leave a ghost journal event", () => {
  const db = fixture();
  try {
    db.exec("BEGIN IMMEDIATE");
    edit(db);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_change_journal").get().n, 1);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_change_journal").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_edit_audit").get().n, 0);
    assert.deepEqual({ ...db.prepare("SELECT body,revision FROM notes WHERE id='one'").get() },
      { body:"Top secret", revision:0 });
  } finally { db.close(); }
});

test("audit provenance and journal are exactly one event per successful write", () => {
  const db = fixture();
  try {
    edit(db);
    assert.throws(() => edit(db,"edit-1"), /note|UNIQUE|revision/i,
      "duplicate receipt or invalid second edit must not create an event");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_change_journal").get().n, 1);
    const event = db.prepare("SELECT * FROM note_change_journal WHERE seq=1").get();
    assert.equal(event.actor_user_id, "alice");
    assert.equal(event.policy_revision, 0);
    assert.equal(event.revision, 1);
    assert.equal(event.receipt_key, "edit-1");
  } finally { db.close(); }
});


test("interleaved Areas retain independent dense journal sequences", () => {
  const db = fixture();
  try {
    db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('bob-private','Bob private','private','bob-personal','bob')").run();
    db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('two','bob-private','Bob secret','No disclosure')").run();
    edit(db, "alice-1", 1000);
    db.prepare("UPDATE notes SET body='Bob revised' WHERE id='two'").run();
    db.prepare(`INSERT INTO note_edit_audit
      (receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,
       revision_before,revision_after,expected_revision,restore_generation,committed_at_ms)
      VALUES ('bob-1','bob','two',NULL,'bob-private',0,0,1,?,
       '00000000-0000-4000-8000-000000000001',?)`).run("c".repeat(64), 1100);
    db.prepare("UPDATE notes SET body='Alice revised again' WHERE id='one'").run();
    db.prepare(`INSERT INTO note_edit_audit
      (receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,
       revision_before,revision_after,expected_revision,restore_generation,committed_at_ms)
      VALUES ('alice-2','alice','one',NULL,'private',0,1,2,?,
       '00000000-0000-4000-8000-000000000001',?)`).run("d".repeat(64), 1200);
    const positions = db.prepare("SELECT area_id,seq FROM note_change_journal ORDER BY area_id,seq").all()
      .map(({ area_id, seq }) => ({ area_id, seq }));
    assert.deepEqual(positions, [
      { area_id:"bob-private", seq:1 }, { area_id:"private", seq:1 }, { area_id:"private", seq:2 },
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_change_journal WHERE area_id='private' AND seq=2").get().n, 1);
  } finally { db.close(); }
});
