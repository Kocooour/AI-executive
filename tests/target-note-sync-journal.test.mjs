import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TARGET_SCHEMA_SQL } from "../lib/target-store-bootstrap.ts";
import {
  TARGET_NOTE_JOURNAL_SCHEMA_SQL, NOTE_SYNC_JOURNAL_PAGE_LIMIT,
  appendTrustedTargetNoteJournalEvent as append,
  readAuthorizedTargetNoteJournalPage as read,
} from "../lib/target-note-sync-journal.ts";

const GEN = "b25e8d19-8c47-4f26-bad3-f6cf08630e11";
const NOW = 1793620000000;
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(TARGET_SCHEMA_SQL);
  db.exec(TARGET_NOTE_JOURNAL_SCHEMA_SQL);
  db.prepare("INSERT INTO metadata(key,value) VALUES('restore_generation',?)").run(GEN);
  for (const id of ["alice", "bob", "carol"])
    db.prepare("INSERT INTO identities(id) VALUES(?)").run(id);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES('wp','personal','alice')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES('ws','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES('private','Private','private','wp','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES('shared','Shared','shared','ws','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES('shared','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES('shared','bob','viewer')").run();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES('p1','shared','Project')").run();
  db.prepare("INSERT INTO notes(id,project_id,area_id,title,body) VALUES('n1','p1',NULL,'Confidential','Never journal the body')").run();
  db.prepare("INSERT INTO notes(id,project_id,area_id,title,body) VALUES('n-private',NULL,'private','Private','Hidden')").run();
  return db;
}
const page = (db, actor, area, after=0, limit=NOTE_SYNC_JOURNAL_PAGE_LIMIT) =>
  read(db, { actorUserId: actor, areaId: area, afterSeq: after, limit });
function edit(db, body="Other confidential body") {
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE notes SET body=? WHERE id='n1'").run(body);
  const result = append(db, "edit", "n1", NOW);
  assert.equal(result.ok, true);
  db.exec("COMMIT");
  return result.seq;
}

test("content-free edit journal is monotonic, bounded and ACL scoped", () => {
  const db=fixture();
  try {
    const first=edit(db);
    const second=edit(db,"Another confidential body");
    assert.deepEqual([first,second],[1,2]);
    const p1=page(db,"bob","shared",0,1);
    assert.ok(p1);
    assert.equal(p1.hasMore,true);
    assert.equal(p1.nextSeq,1);
    assert.equal(p1.headSeq,2);
    assert.equal(p1.events.length,1);
    assert.deepEqual(p1.events[0], {
      seq:1,noteId:"n1",areaId:"shared",projectId:"p1",op:"edit",revision:1,
    });
    assert.equal(JSON.stringify(p1).includes("confidential"),false);
    const p2=page(db,"bob","shared",p1.nextSeq,1);
    assert.ok(p2);
    assert.equal(p2.nextSeq,2);
    assert.equal(p2.hasMore,false);
    assert.equal(p2.events[0].revision,2);
    assert.equal(page(db,"bob","private"),null);
    assert.equal(page(db,"carol","shared"),null);
    assert.equal(page(db,"alice","shared",3),null);
    assert.equal(page(db,"bob","shared",-1),null);
    assert.equal(page(db,"bob","shared",0,101),null);
    assert.equal(page(db,"bob","shared",0,0),null);
  } finally {db.close();}
});

test("tombstone deletion is represented without contents; read is denied after removal of membership", () => {
  const db=fixture();
  try {
    edit(db);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO note_tombstones(id,area_id,project_id,revision,deleted_at_ms) VALUES('n1','shared','p1',2,?)").run(NOW+1);
    db.prepare("DELETE FROM notes WHERE id='n1'").run();
    assert.deepEqual(append(db,"delete","n1",NOW+1),{ok:true,seq:2});
    db.exec("COMMIT");
    const p=page(db,"bob","shared");
    assert.ok(p);
    assert.deepEqual(p.events.map(e=>[e.op,e.revision]),[["edit",1],["delete",2]]);
    assert.equal(JSON.stringify(p).includes("Never journal"),false);
    db.prepare("DELETE FROM area_members WHERE area_id='shared' AND user_id='bob'").run();
    assert.equal(page(db,"bob","shared"),null);
  } finally {db.close();}
});

test("policy revision fence rejects retroactive disclosure; new-position events can be read", () => {
  const db=fixture();
  try {
    edit(db);
    const before=page(db,"bob","shared");
    assert.ok(before);
    db.prepare("UPDATE area_members SET role='editor' WHERE area_id='shared' AND user_id='bob'").run();
    assert.equal(page(db,"bob","shared",0),null);
    edit(db,"New edit after role change");
    const after=page(db,"bob","shared",before.nextSeq);
    assert.ok(after);
    assert.deepEqual(after.events.map(e=>e.revision),[2]);
    db.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'").run("c25e8d19-8c47-4f26-bad3-f6cf08630e11");
    assert.equal(page(db,"bob","shared",before.nextSeq),null);
  } finally {db.close();}
});

test("append requires a transaction and matching existing note or tombstone", () => {
  const db=fixture();
  try {
    assert.deepEqual(append(db,"edit","n1",NOW),{ok:false});
    db.exec("BEGIN IMMEDIATE");
    assert.deepEqual(append(db,"edit","n1",NOW),{ok:false},"initial revision is not a note edit");
    assert.deepEqual(append(db,"delete","n1",NOW),{ok:false},"requires an actual tombstone");
    assert.deepEqual(append(db,"edit","missing",NOW),{ok:false});
    assert.deepEqual(append(db,"edit","n1",-1),{ok:false});
    db.prepare("UPDATE notes SET body='Update' WHERE id='n1'").run();
    assert.deepEqual(append(db,"edit","n1",NOW),{ok:true,seq:1});
    assert.deepEqual(append(db,"edit","n1",NOW),{ok:false},"duplicate revision rejected");
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_sync_journal").get().n,0);
    assert.equal(db.prepare("SELECT revision FROM notes WHERE id='n1'").get().revision,0);
    assert.equal(page(db,"bob","shared")?.headSeq,0);
  } finally {db.close();}
});

test("append-only sequence forbids edits, deletes, replacement and gaps", () => {
  const db=fixture();
  try {
    edit(db);
    assert.throws(()=>db.prepare("UPDATE note_sync_journal SET op='delete' WHERE seq=1").run());
    assert.throws(()=>db.prepare("DELETE FROM note_sync_journal WHERE seq=1").run());
    assert.throws(()=>db.prepare(`INSERT OR REPLACE INTO note_sync_journal
      (seq,note_id,area_id,op,revision,policy_revision,restore_generation,committed_at_ms)
      SELECT seq,note_id,area_id,op,revision,policy_revision,restore_generation,committed_at_ms
      FROM note_sync_journal WHERE seq=1`).run());
    assert.throws(()=>db.prepare(`INSERT INTO note_sync_journal
      (seq,note_id,area_id,op,revision,policy_revision,restore_generation,committed_at_ms)
      VALUES(99,'unknown','shared','edit',4,1,?,?)`).run(GEN,NOW));
    assert.equal(page(db,"bob","shared")?.events.length,1);
  } finally {db.close();}
});
