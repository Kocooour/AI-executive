import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readAuthorizedInboxSuggestionSnapshot} from "../lib/target-inbox-suggestion-snapshot.ts";
import {suggestInboxByRules,inboxAIAllowedInput} from "../lib/target-inbox-suggestions.ts";

const GEN="123e4567-e89b-42d3-a456-426614174000";

function dbFixture(){
  const db=new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE identities (id TEXT PRIMARY KEY);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY,kind TEXT,owner_user_id TEXT);
    CREATE TABLE areas (id TEXT PRIMARY KEY,title TEXT,kind TEXT,
      workspace_id TEXT,owner_user_id TEXT,policy_revision INTEGER,
      content_revision INTEGER,project_content_revision INTEGER);
    CREATE TABLE projects (id TEXT PRIMARY KEY,title TEXT,area_id TEXT,
      revision INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,area_id TEXT,
      project_id TEXT,revision INTEGER,triage_revision INTEGER,
      triage_state TEXT,status TEXT,assignee_user_id TEXT);
    CREATE TABLE personal_plan_epochs (user_id TEXT PRIMARY KEY,revision INTEGER);
    CREATE TABLE personal_task_plans (user_id TEXT,task_id TEXT,
      when_on TEXT,revision INTEGER);
    INSERT INTO metadata VALUES ('restore_generation','${GEN}');
    INSERT INTO identities VALUES ('owner'),('other');
    INSERT INTO workspaces VALUES ('mine','personal','owner'),
      ('foreign','personal','other'),('shared','shared','owner');
    INSERT INTO areas VALUES
      ('personal','Osobní','private','mine','owner',2,3,4),
      ('kitchen','Kuchyň','private','mine','owner',1,2,3),
      ('outsider','Cizí','private','foreign','other',4,5,6),
      ('collab','Sdílená','shared','shared','owner',7,8,9);
    INSERT INTO projects VALUES
      ('renovation','Rekonstrukce','kitchen',3),
      ('foreign-project','Cizí projekt','outsider',5),
      ('shared-project','Sdílený projekt','collab',6);
    INSERT INTO tasks VALUES
      ('source','Připravit rekonstrukce', 'personal',NULL,1,0,'unprocessed','open',NULL),
      ('foreign-task','Cizí úkol','outsider',NULL,1,0,'unprocessed','open',NULL),
      ('shared-task','Sdílený úkol','collab',NULL,1,0,'unprocessed','open',NULL),
      ('processed','Zpracováno','personal',NULL,1,1,'processed','open',NULL),
      ('done','Dokončeno','personal',NULL,1,0,'unprocessed','completed',NULL);
    INSERT INTO personal_plan_epochs VALUES('owner',4),('other',0);
    INSERT INTO personal_task_plans VALUES('owner','source','2026-11-23',3),
      ('other','source','2026-12-25',7);
  `);
  return db;
}

test("C-3b candidates: pinned SQL returns only actor-private Areas/projects and own plan",()=>{
  const db=dbFixture();
  try{
    const read=readAuthorizedInboxSuggestionSnapshot(db,"owner","source",GEN);
    assert.ok(read);
    assert.equal(read.snapshot.taskTitle,"Připravit rekonstrukce");
    assert.deepEqual(read.snapshot.privateAreas.map(a=>a.name),["Kuchyň","Osobní"]);
    assert.deepEqual(read.snapshot.privateOpenProjects.map(p=>p.name),["Rekonstrukce"]);
    assert.equal(read.personalWhenOn,"2026-11-23");
    assert.equal(read.personalWhenRevision,3);
    assert.equal(read.personalPlanEpoch,4);
    assert.match(read.candidateFingerprint,/^[a-f0-9]{64}$/);
    assert.match(read.taskWriteRevision,/^[a-f0-9]{64}$/);
    const allowed=inboxAIAllowedInput(read.snapshot);
    assert.deepEqual(allowed,{
      taskTitle:"Připravit rekonstrukce",
      privateAreaNames:["Kuchyň","Osobní"],
      privateOpenProjectNames:["Rekonstrukce"],
    });
    assert.equal(JSON.stringify(allowed).includes("Cizí"),false);
    assert.equal(JSON.stringify(allowed).includes("Sdílen"),false);
    assert.equal(JSON.stringify(allowed).includes("2026-11-23"),false);
    assert.equal(suggestInboxByRules(read.snapshot).changes.projectId,"renovation");
  }finally{db.close();}
});

test("C-3b candidates: shared, foreign, processed, completed and wrong restore fail closed",()=>{
  const db=dbFixture();
  try{
    for(const [actor,task] of [
      ["owner","foreign-task"],["other","source"],["owner","shared-task"],
      ["owner","processed"],["owner","done"],["owner","not-existing"],
    ])assert.equal(readAuthorizedInboxSuggestionSnapshot(db,actor,task,GEN),null,
      actor+" / "+task);
    assert.equal(readAuthorizedInboxSuggestionSnapshot(
      db,"owner","source","123e4567-e89b-42d3-a456-426614174001"),null);
    assert.equal(readAuthorizedInboxSuggestionSnapshot(
      db,"not a valid actor","source",GEN),null);
  }finally{db.close();}
});

test("C-3b candidates: project task inherits private Area, corrupted project link rejected",()=>{
  const db=dbFixture();
  try{
    db.prepare("UPDATE tasks SET area_id=NULL,project_id='renovation' WHERE id='source'").run();
    let read=readAuthorizedInboxSuggestionSnapshot(db,"owner","source",GEN);
    assert.ok(read);
    assert.equal(read.snapshot.currentProjectId,"renovation");
    assert.equal(read.snapshot.currentAreaId,"kitchen");
    db.prepare("UPDATE tasks SET project_id='foreign-project' WHERE id='source'").run();
    assert.equal(readAuthorizedInboxSuggestionSnapshot(db,"owner","source",GEN),null);
    db.prepare("UPDATE tasks SET project_id='renovation',area_id='kitchen' WHERE id='source'").run();
    assert.equal(readAuthorizedInboxSuggestionSnapshot(db,"owner","source",GEN),null);
  }finally{db.close();}
});

test("C-3b candidates: no truncated set; changes to ACL/Area/project/plan alter witness",()=>{
  const db=dbFixture();
  try{
    const first=readAuthorizedInboxSuggestionSnapshot(db,"owner","source",GEN);
    assert.ok(first);
    db.prepare("UPDATE areas SET policy_revision=policy_revision+1 WHERE id='personal'").run();
    const second=readAuthorizedInboxSuggestionSnapshot(db,"owner","source",GEN);
    assert.ok(second);
    assert.notEqual(second.candidateFingerprint,first.candidateFingerprint);
    db.prepare("UPDATE projects SET title='Renovace',revision=revision+1 WHERE id='renovation'").run();
    const third=readAuthorizedInboxSuggestionSnapshot(db,"owner","source",GEN);
    assert.ok(third);
    assert.notEqual(third.candidateFingerprint,second.candidateFingerprint);
    db.prepare("UPDATE personal_plan_epochs SET revision=revision+1 WHERE user_id='owner'").run();
    const fourth=readAuthorizedInboxSuggestionSnapshot(db,"owner","source",GEN);
    assert.ok(fourth);
    assert.notEqual(fourth.candidateFingerprint,third.candidateFingerprint);
    const insert=db.prepare("INSERT INTO projects(id,title,area_id,revision) VALUES(?,?,?,0)");
    for(let i=0;i<128;i++)insert.run("p"+i,"Projekt "+i,"personal");
    assert.equal(readAuthorizedInboxSuggestionSnapshot(db,"owner","source",GEN),null,
      "never truncate candidate set to 128 and create false uniqueness");
  }finally{db.close();}
});
