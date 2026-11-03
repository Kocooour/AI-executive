import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2d3e-temporal-read-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "unchanged");
const oldData = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
after(() => {
  if (oldData === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = oldData;
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "unchanged");
  rmSync(root, { recursive: true, force: true });
});

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { inspectIsolatedTargetStore } = await import("../lib/target-store-preflight.ts");
const { readAuthorizedTemporalTaskPage, readAuthorizedTemporalTaskDetail } =
  await import("../lib/target-task-temporal-read-model.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
});
const db = new DatabaseSync(stage.databasePath);
db.exec("PRAGMA foreign_keys=ON");
for (const name of ["bob","carol","erin"]) {
  db.prepare("INSERT INTO identities(id) VALUES (?)").run(name);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)").run(name,name);
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
    .run(name+"-private",name,name,name);
}
for (const [ws,owner] of [["family","alice"],["other","erin"]]) {
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)").run(ws,owner);
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'shared',?,?)")
    .run(ws+"-area",ws,ws,owner);
}
for (const [area,actor,role] of [
  ["family-area","alice","admin"],["family-area","bob","editor"],
  ["family-area","carol","viewer"],["other-area","erin","admin"],
]) db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)")
  .run(area,actor,role);
db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('p-family','family-area','Family')").run();
const insert = db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id) VALUES (?,?,?,?,?)");
insert.run("p-alice",stage.unassignedAreaId,null,"Private Alice",null);
insert.run("p-bob","bob-private",null,"Private Bob",null);
insert.run("s-alice","family-area",null,"Shared Alice","alice");
insert.run("s-bob","family-area",null,"Shared Bob","bob");
insert.run("s-other","family-area",null,"Shared Unassigned",null);
insert.run("s-child",null,"p-family","Family child","bob");
insert.run("x-secret","other-area",null,"Hidden Secret","erin");
db.prepare("UPDATE tasks SET due_on='2026-11-03' WHERE id='p-alice'").run();
db.prepare("UPDATE tasks SET due_on='2026-11-10' WHERE id='s-bob'").run();
db.prepare("UPDATE tasks SET due_on='2028-02-29' WHERE id='s-child'").run();
db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793700000000 WHERE id IN ('p-bob','s-alice','s-child')").run();
const reader = new DatabaseSync(stage.databasePath,{ readOnly:true });
const store = { stagingDirectory:stage.directory, expectedRestoreGeneration:stage.restoreGeneration };
const authority = new TargetStagingSessionAuthority(store);
after(() => { authority.close();reader.close();db.close(); });
const list = (actor,scope,status="all",extra={}) =>
  readAuthorizedTemporalTaskPage(reader,{
    actorUserId:actor,scope,status,limit:100,offset:0,
    restoreGeneration:stage.restoreGeneration,...extra,
  });
const detail=(actor,id)=>readAuthorizedTemporalTaskDetail(reader,actor,id);
const ids=p=>p.tasks.map(t=>t.id);

test("personal/shared/my-plan status filters honor current Area ACL and assignment", () => {
  assert.deepEqual(ids(list("alice","personal")),["p-alice"]);
  assert.deepEqual(ids(list("bob","personal")),["p-bob"]);
  assert.deepEqual(ids(list("bob","shared")),["s-alice","s-bob","s-child","s-other"]);
  assert.deepEqual(ids(list("bob","my-plan")),["p-bob","s-bob","s-child"]);
  assert.deepEqual(ids(list("carol","my-plan")),[]);
  assert.deepEqual(ids(list("carol","shared","completed")),["s-alice","s-child"]);
  assert.deepEqual(ids(list("bob","my-plan","open")),["s-bob"]);
  assert.deepEqual(ids(list("bob","my-plan","completed")),["p-bob","s-child"]);
  assert.deepEqual(ids(list("erin","shared")),["x-secret"]);
  assert.deepEqual(ids(list("missing","shared")),[]);
});

test("temporal fields are canonical date/status, not user-private today or other assignee", () => {
  const item=detail("bob","s-child");
  assert.equal(item.task.dueOn,"2028-02-29");
  assert.equal(item.task.completedAtMs,1793700000000);
  assert.equal(item.task.status,"completed");
  assert.equal(item.task.projectId,"p-family");
  assert.equal(item.task.assignedToMe,true);
  assert.equal(item.task.areaId,"family-area");
  assert.deepEqual(Object.keys(item.task).sort(),[
    "areaId","areaKind","assignedToMe","completedAtMs","dueOn","id","projectId","status","title",
  ]);
  assert.equal(detail("carol","s-bob").task.assignedToMe,false);
  assert.equal(detail("alice","p-alice").task.dueOn,"2026-11-03");
  assert.equal(detail("alice","p-alice").task.completedAtMs,null);
  assert.equal("assignedToMe" in detail("alice","p-alice").task,false);
});

test("private and non-member tasks are not locatable, including completed attribution", () => {
  for(const [actor,id] of [
    ["bob","p-alice"],["alice","p-bob"],["carol","p-bob"],
    ["bob","x-secret"],["carol","x-secret"],["missing","s-bob"],
    ["bob","does-not-exist"],
  ]) assert.equal(detail(actor,id),null,actor+"/"+id);
  assert.equal(detail("bob"," s-bob"),null);
  assert.equal(detail("bob",""),null);
  assert.equal(list("bob","shared","all",{actorUserId:"not-an-id!"}),null);
});

test("bounded pagination has stable revision, own-only Area witness and date ABA stales", () => {
  const first=list("bob","shared","open",{limit:1});
  assert.deepEqual(ids(first),["s-bob"]);
  assert.equal(first.hasMore,true);
  const next=list("bob","shared","open",{limit:1,offset:1});
  assert.deepEqual(ids(next),["s-other"]);
  assert.equal(next.hasMore,false);
  assert.equal(first.revision,next.revision);
  assert.ok(first.linearization.areas.every(a=>a.areaId==="family-area"));
  assert.equal(first.linearization.actorUserId,"bob");
  const rev=first.revision;
  db.prepare("UPDATE tasks SET due_on=NULL WHERE id='s-bob'").run();
  db.prepare("UPDATE tasks SET due_on='2026-11-10' WHERE id='s-bob'").run();
  assert.notEqual(list("bob","shared","open").revision,rev);
  assert.equal(list("erin","shared").revision,list("erin","shared").revision);
  for(const request of [{limit:101},{limit:0},{offset:-1},{offset:1_000_001},
    {scope:"all"},{status:"today"},{restoreGeneration:"invalid"}])
    assert.equal(list("bob","shared","open",request),null,JSON.stringify(request));
});

test("pinned authenticated facade returns same actor-scoped temporal data, denies invalid identity", () => {
  assert.deepEqual(ids(authority.readTemporalTaskPage("bob","my-plan","completed",100,0)),
    ["p-bob","s-child"]);
  assert.equal(authority.readTemporalTaskDetail("bob","x-secret"),null);
  assert.equal(authority.readTemporalTaskPage("not a valid id","shared","all",10,0),null);
  assert.equal(authority.readTemporalTaskDetail("missing","s-bob"),null);
});

test("role revocation immediately denies former editor without exposing retained completion", () => {
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id IN ('s-bob','s-child')").run();
  db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.deepEqual(ids(list("bob","shared")),[]);
  assert.deepEqual(ids(list("bob","my-plan")),["p-bob"]);
  assert.equal(detail("bob","s-child"),null);
  assert.equal(authority.readTemporalTaskDetail("bob","s-child"),null);
  assert.deepEqual(ids(list("carol","shared","completed")),["s-alice","s-child"]);
  assert.deepEqual(inspectIsolatedTargetStore({
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
    mode:"r2-model",
  }),{ok:true,mode:"r2-model",issues:[]});
});
