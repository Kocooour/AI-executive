import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TARGET_SCHEMA_SQL } from "../lib/target-store-bootstrap.ts";
import { readAuthorizedTargetNoteSyncPage as read } from "../lib/target-note-sync-read-model.ts";

const SECRET = "server-only-note-sync-secret-of-sufficient-length";
const GENERATION = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(TARGET_SCHEMA_SQL);
  db.prepare("INSERT INTO metadata(key,value) VALUES ('restore_generation',?)").run(GENERATION);
  for (const id of ["alice", "bob", "carol", "outsider"])
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(id);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('area','Team','shared','team','alice')").run();
  for (const [id, role] of [["alice","admin"],["bob","editor"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('area',?,?)").run(id, role);
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('one','area','Secret','body')").run();
  return db;
}
function page(db, actor="bob", cursor, limit=100) {
  return read(db, {actorUserId:actor,areaId:"area",sessionEpoch:0,secret:SECRET,cursor,limit,
    nowSeconds:1_800_000_000});
}
function edit(db, receipt="edit-1") {
  const before = db.prepare("SELECT revision FROM notes WHERE id='one'").get().revision;
  db.prepare("UPDATE notes SET body=body||'!' WHERE id='one'").run();
  db.prepare(`INSERT INTO note_edit_audit
    (receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,
     revision_before,revision_after,expected_revision,restore_generation,committed_at_ms)
    VALUES (?,'alice','one',NULL,'area',?, ?, ?, ?, ?, 1000)`)
    .run(receipt, db.prepare("SELECT policy_revision AS p FROM areas WHERE id='area'").get().p,
      before,before+1,"a".repeat(64),GENERATION);
}
function deletion(db) {
  const before = db.prepare("SELECT revision FROM notes WHERE id='one'").get().revision;
  db.prepare("INSERT INTO note_tombstones(id,area_id,revision,deleted_at_ms) VALUES ('one','area',?,2000)")
    .run(before+1);
  db.prepare("DELETE FROM notes WHERE id='one'").run();
  db.prepare(`INSERT INTO note_delete_audit
    (receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,
     revision_before,tombstone_revision,expected_revision,restore_generation,committed_at_ms)
    VALUES ('delete-1','alice','one',NULL,'area',?,?,? ,?, ?,2000)`)
    .run(db.prepare("SELECT policy_revision AS p FROM areas WHERE id='area'").get().p,
      before,before+1,"b".repeat(64),GENERATION);
}
const witness = db => db.prepare("SELECT note_sync_revision AS n FROM areas WHERE id='area'").get().n;

test("bootstrap starts at current Area head; bounded edit/delete pages advance witness exactly once", () => {
  const db=fixture();
  try {
    edit(db,"historical");
    const boot=page(db);
    assert.deepEqual(boot.entries.map(x=>x.id),["one"]);
    assert.equal(page(db,"outsider"),null);
    assert.deepEqual(page(db,"bob",boot.cursor).changes,[],"prior identifiers stay behind baseline");
    const before=witness(db);
    edit(db,"new-edit");
    assert.equal(witness(db),before+1);
    const afterEdit=page(db,"bob",boot.cursor,1);
    assert.deepEqual(afterEdit.changes.map(x=>[x.kind,x.noteId,x.revision]),[["edit","one",2]]);
    const beforeDelete=witness(db);
    deletion(db);
    assert.equal(witness(db),beforeDelete+1);
    const afterDelete=page(db,"bob",afterEdit.cursor,1);
    assert.deepEqual(afterDelete.changes.map(x=>[x.kind,x.noteId,x.revision]),[["delete","one",3]]);
    assert.deepEqual(page(db,"bob",afterDelete.cursor).changes,[]);
  } finally { db.close(); }
});

test("raw create, edit, reparent and parent ABA force full rebootstrap", () => {
  for (const mutation of [
    db => db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('two','area','N','B')").run(),
    db => db.prepare("UPDATE notes SET body='raw' WHERE id='one'").run(),
    db => { db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('p','area','P')").run();
      db.prepare("UPDATE notes SET project_id='p',area_id=NULL WHERE id='one'").run(); },
    db => { db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('p','area','P')").run();
      db.prepare("UPDATE notes SET project_id='p',area_id=NULL WHERE id='one'").run();
      db.prepare("UPDATE projects SET title='Q' WHERE id='p'").run();
      db.prepare("UPDATE projects SET title='P' WHERE id='p'").run(); },
  ]) {
    const db=fixture();
    try { const boot=page(db); mutation(db); assert.equal(page(db,"bob",boot.cursor),null); }
    finally { db.close(); }
  }
});

test("a parent title ABA alone invalidates a child note cursor", () => {
  const db=fixture();
  try {
    db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('p','area','P')").run();
    db.prepare("UPDATE notes SET project_id='p',area_id=NULL WHERE id='one'").run();
    const boot=page(db);
    const before=witness(db);
    db.prepare("UPDATE projects SET title='Q' WHERE id='p'").run();
    db.prepare("UPDATE projects SET title='P' WHERE id='p'").run();
    assert.equal(witness(db),before+2);
    assert.equal(page(db,"bob",boot.cursor),null);
  } finally { db.close(); }
});

test("a backlog spans pages without replaying rows; rollback and witness reset are rejected", () => {
  const db=fixture();
  try {
    const boot=page(db);
    const before=witness(db);
    db.exec("BEGIN");
    edit(db,"rolled-back");
    db.exec("ROLLBACK");
    assert.equal(witness(db),before);
    assert.deepEqual(page(db,"bob",boot.cursor).changes,[]);
    for (const receipt of ["edit-1","edit-2","edit-3"]) edit(db,receipt);
    assert.equal(witness(db),before+3);
    const first=page(db,"bob",boot.cursor,1);
    assert.equal(first.more,true);
    const second=page(db,"bob",first.cursor,1);
    assert.equal(second.more,true);
    const third=page(db,"bob",second.cursor,1);
    assert.equal(third.more,false);
    assert.deepEqual([first,second,third].flatMap(p=>p.changes.map(c=>c.seq)),[1,2,3]);
    assert.throws(()=>db.prepare("UPDATE areas SET note_sync_revision=0 WHERE id='area'").run(),
      /Area note sync revision/);
    assert.throws(()=>db.prepare("UPDATE areas SET note_sync_revision=note_sync_revision+2 WHERE id='area'").run(),
      /Area note sync revision/);
  } finally { db.close(); }
});

test("restore generation invalidates old cursor even when notes match", () => {
  const db=fixture();
  try {
    const old=page(db);
    db.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'")
      .run("00000000-0000-4000-8000-000000000002");
    assert.equal(page(db,"bob",old.cursor),null);
    const fresh=page(db);
    assert.deepEqual(fresh.entries.map(x=>x.id),["one"]);
  } finally { db.close(); }
});

test("policy role, removal/re-addition and epoch changes reject continuation; new member starts at now", () => {
  const db=fixture();
  try {
    const old=page(db);
    edit(db);
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('area','carol','viewer')").run();
    const newcomer=page(db,"carol");
    assert.deepEqual(page(db,"carol",newcomer.cursor).changes,[]);
    assert.equal(page(db,"bob",old.cursor),null);
    db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='area' AND user_id='bob'").run();
    assert.equal(page(db,"bob",old.cursor),null);
    db.prepare("DELETE FROM area_members WHERE area_id='area' AND user_id='carol'").run();
    assert.equal(page(db,"carol",newcomer.cursor),null);
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('area','carol','viewer')").run();
    assert.equal(page(db,"carol",newcomer.cursor),null);
    assert.equal(read(db,{actorUserId:"carol",areaId:"area",sessionEpoch:1,
      secret:SECRET,cursor:page(db,"carol").cursor,limit:100,nowSeconds:1_800_000_000}),null);
  } finally { db.close(); }
});
