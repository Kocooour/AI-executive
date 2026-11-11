import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {spawnSync} from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const envNames = [
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH", "AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-private-note-create-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "untouched");
Object.assign(process.env, {
  NODE_ENV: "production", AI_EXECUTIVE_DATA_DIR: legacy,
  AI_EXECUTIVE_AUTH_ENABLED: "true",
  AI_EXECUTIVE_PASSWORD_HASH: "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
    ":" + Buffer.alloc(64, 2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET: "r3-private-note-create-synthetic-secret-long-enough",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED: "true",
});
const { bootstrapIsolatedTargetStore, TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX } =
  await import("../lib/target-store-bootstrap.ts");
const { TARGET_STAGING_JOURNAL_FILENAME } =
  await import("../lib/target-staging-anchor-journal.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const { POST } = await import("../app/api/target-staging/notes/route.ts");
const { GET: GET_NOTE } = await import("../app/api/target-staging/notes/[noteId]/route.ts");
const {POST:PREVIEW_CREATE}=await import("../app/api/target-staging/notes/create-preview/route.ts");
const {POST:RECOVER_CREATE}=await import("../app/api/target-staging/notes/create-recovery/route.ts");
const {parseNoteCreateRecoveryReply}=await import("../lib/target-staging-note-create-process.ts");
const {readStagingNoteCreateRecoveryInChild}=await import("../lib/target-staging-note-create-process.ts");
const {readTargetNoteCreateRecovery}=await import("../lib/target-note-create-status.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const { parseNoteCreateReply } = await import("../lib/target-staging-note-create-process.ts");

after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "untouched");
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-space','personal','bob')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Private','private','bob-space','bob','unassigned')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Shared','shared','team','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','viewer')").run();
  db.close();
  Object.assign(process.env, {
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION: stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID: "alice",
  });
  return { stage, store: {
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  } };
}
const owner = () => sessionCookieName + "=" + createSessionToken();
function session(fx, actor) {
  const result = durable.issueDurableTargetStagingSession(fx.store, actor, 900);
  assert.equal(result.ok, true, JSON.stringify(result));
  return durable.TARGET_STAGING_SESSION_COOKIE + "=" + result.sessionToken;
}
function body(fx, changes = {}) {
  return {
    noteId: randomUUID(), commandId: randomUUID(),
    areaId: fx.stage.unassignedAreaId,
    restoreGeneration: fx.stage.restoreGeneration,
    title: "Private idea", body: "Some captured text",
    ...changes,
  };
}
function send(data, cookie = owner(), headers = {}, url = "http://localhost:3001/api/target-staging/notes") {
  return POST(new Request(url, { method: "POST", headers: {
    ...(cookie ? { cookie } : {}),
    "origin": "http://localhost:3001",
    "content-type": "application/json",
    "x-lumi-target-protocol": "1",
    "x-forwarded-for": "10.9.0.25",
    ...headers,
  }, body: JSON.stringify(data) }));
}
function getNoteHttp(id, cookie) {
  const request = new Request(
    "http://localhost:3001/api/target-staging/notes/" + encodeURIComponent(id),
    { headers: {
      ...(cookie ? { cookie } : {}), "x-forwarded-for": "10.9.0.25",
    } },
  );
  return GET_NOTE(request, { params: Promise.resolve({ noteId: id }) });
}
function note(fx, id) {
  const db = new DatabaseSync(fx.stage.databasePath, { readOnly: true });
  try {
    return db.prepare("SELECT id,title,body,area_id,project_id FROM notes WHERE id=?").get(id);
  } finally { db.close(); }
}
/** Content-free state for proving a rejected create has no durable side effect. */
function createPersistenceState(fx, noteId) {
  const db = new DatabaseSync(fx.stage.databasePath, { readOnly: true });
  try {
    const count = (sql, ...args) => db.prepare(sql).get(...args).n;
    return {
      noteExists: db.prepare("SELECT 1 FROM notes WHERE id=?").get(noteId) !== undefined,
      notes: count("SELECT COUNT(*) AS n FROM notes"),
      lifecycleReceipts: count("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?",
        TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX + "%"),
      lifecycleAudit: count("SELECT COUNT(*) AS n FROM note_lifecycle_audit"),
      changeSequence: count("SELECT COALESCE(MAX(seq),0) AS n FROM change_log"),
      anchor: db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'").get().value,
      journal: readFileSync(path.join(fx.stage.directory, TARGET_STAGING_JOURNAL_FILENAME), "utf8"),
    };
  } finally { db.close(); }
}
async function checkedRead(response, status) {
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return data;
}
async function checked(response, status) {
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(data).includes("captured text"), false);
  return data;
}

test("owner creates a standalone private note, replay is idempotent and no legacy data changes", async () => {
  const fx = fixture();
  const command = body(fx);
  assert.deepEqual(await checked(await send(command), 201),
    { ok: true, noteId: command.noteId });
  assert.deepEqual({ ...note(fx, command.noteId) }, {
    id: command.noteId, title: command.title, body: command.body,
    area_id: fx.stage.unassignedAreaId, project_id: null,
  });
  const fetched = await checkedRead(await getNoteHttp(command.noteId, owner()), 200);
  assert.deepEqual(fetched.note, {
    id: command.noteId, title: command.title, body: command.body,
    areaId: fx.stage.unassignedAreaId, areaKind: "private",
    projectId: null, revision: 0,
  });
  assert.deepEqual(await checked(await send(command), 200),
    { ok: true, noteId: command.noteId, replayed: true });
  assert.equal((await checked(await send({ ...command, title: "Changed" }), 409)).error, "Revision conflict");
});
test("durable session may create only into its own private Area", async () => {
  const fx = fixture();
  const bob = session(fx, "bob");
  const allowed = body(fx, { areaId: "bob-private" });
  assert.equal((await checked(await send(allowed, bob), 201)).noteId, allowed.noteId);
  assert.equal((await checkedRead(await getNoteHttp(allowed.noteId, bob), 200)).note.id, allowed.noteId);
  assert.equal((await checked(await getNoteHttp(allowed.noteId, owner()), 404)).error, "Not found");
  const cross = body(fx);
  assert.equal((await checked(await send(cross, bob), 404)).error, "Not found");
  assert.equal(note(fx, cross.noteId), undefined);
  const shared = body(fx, { areaId: "team-area" });
  assert.equal((await checked(await send(shared, bob), 404)).error, "Not found");
  assert.equal(note(fx, shared.noteId), undefined);
  const ownerShared = body(fx, { areaId: "team-area" });
  assert.equal((await checked(await send(ownerShared), 404)).error, "Not found");
});
test("revoked durable session cannot POST a private note or leave receipt, audit or journal changes", async () => {
  const fx = fixture();
  const bob = session(fx, "bob");
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const live = durable.verifyDurableTargetStagingSessionLive(fx.store, tokenHash);
  assert.ok(live?.sessionId);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, live.sessionId).ok, true);
  const command = body(fx, { areaId: "bob-private" });
  const before = createPersistenceState(fx, command.noteId);
  assert.equal(before.noteExists, false);
  assert.equal(before.lifecycleReceipts, 0);
  assert.equal(before.lifecycleAudit, 0);
  const rejected = await checked(await send(command, bob), 401);
  assert.equal(rejected.code, "session_revoked");
  assert.deepEqual(createPersistenceState(fx, command.noteId), before,
    "revoked HTTP create must not insert note, receipt, audit or journal intent");

  // Replaying the rejected command with the same stale cookie must remain inert.
  const retry = await checked(await send(command, bob), 401);
  assert.equal(retry.code, "session_revoked");
  assert.deepEqual(createPersistenceState(fx, command.noteId), before);
});

test("missing flag, unbound identity and invalid protocol/shape never write", async () => {
  const fx = fixture();
  const cmd = body(fx);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED = "false";
  assert.equal((await checked(await send(cmd), 404)).error, "Not found");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED = "true";
  assert.equal((await checked(await send(cmd, ""), 401)).error !== undefined, true);
  assert.equal((await checked(await send(cmd, owner(), { "x-lumi-target-protocol": "0" }), 400)).code,
    "protocol_unsupported");
  assert.equal((await checked(await send(cmd, owner(), { origin: "https://elsewhere.invalid" }), 403)).error,
    "Cross-origin request rejected");
  assert.equal((await checked(await send({ ...cmd, projectId: "team-project" }), 400)).error,
    "Invalid request");
  assert.equal((await checked(await send({ ...cmd, workspaceId: "team" }), 400)).error,
    "Invalid request");
  assert.equal((await checked(await send({ ...cmd, entities: [] }), 400)).code,
    "legacy_snapshot_rejected");
  assert.equal((await checked(await send({ ...cmd, noteId: "arbitrary" }), 400)).error,
    "Invalid request");
  assert.equal((await checked(await send({ ...cmd, restoreGeneration: randomUUID() }), 409)).code,
    "resync_required");
  assert.equal(note(fx, cmd.noteId), undefined);
});
test("bounded child result accepts only exact content-free protocol", () => {
  assert.deepEqual(parseNoteCreateReply({ ok: true, replayed: true }), { ok: true, replayed: true });
  assert.deepEqual(parseNoteCreateReply({ ok: false, reason: "resync_required" }),
    { ok: false, reason: "resync_required" });
  for (const invalid of [{ ok: true, noteId: "private" }, { ok: false, reason: "unauthorized" },
    { ok: true, replayed: false }, { ok: false, reason: "write_failed", body: "leak" }]) {
    assert.equal(parseNoteCreateReply(invalid), null);
  }
});

/** Preflight and receipt are read-only, same-origin, current actor/ACL guarded. */
const req=(endpoint,data,cookie=owner(),custom={})=>new Request(
  "http://localhost:3001/api/target-staging/notes/"+endpoint,{
    method:"POST",headers:{
      ...(cookie?{cookie}:{}),origin:"http://localhost:3001",
      "x-lumi-target-protocol":"1","content-type":"application/json",
      "x-forwarded-for":"10.9.0.25",...custom,
    },body:JSON.stringify(data),
  });
test("live private CREATE preview returns generation only to an authorized writer",async()=>{
  const fx=fixture(),bob=session(fx,"bob");
  const alice=await checked(await PREVIEW_CREATE(req("create-preview",{
    areaId:fx.stage.unassignedAreaId,
  })),200);
  assert.deepEqual(alice,{restoreGeneration:fx.stage.restoreGeneration});
  assert.deepEqual(await checked(await PREVIEW_CREATE(req("create-preview",{
    areaId:"bob-private",
  },bob)),200),{restoreGeneration:fx.stage.restoreGeneration});
  for(const areaId of ["team-area","bob-private","not-an-area"]){
    const a=await checked(await PREVIEW_CREATE(req("create-preview",{areaId})),404);
    assert.equal(a.error,"Not found");
  }
  assert.equal((await checked(await PREVIEW_CREATE(req("create-preview",{
    areaId:fx.stage.unassignedAreaId,
  },bob)),404)).error,"Not found");
  assert.equal((await checked(await PREVIEW_CREATE(req("create-preview",{
    areaId:fx.stage.unassignedAreaId,
  },"")),401)).error!==undefined,true);
  const db=new DatabaseSync(fx.stage.databasePath,{readOnly:true});
  try{assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n,0);}
  finally{db.close();}
});
test("read-only CREATE receipt confirms the exact owner commit but never text",async()=>{
  const fx=fixture(),cmd=body(fx),bob=session(fx,"bob");
  // Distinguish the local, actor-scoped SQLite receipt scan from its bounded
  // subprocess transport and the final server HTTP contract.
  const db=new DatabaseSync(fx.stage.databasePath,{readOnly:true});
  try{assert.deepEqual(readTargetNoteCreateRecovery(db,"alice",cmd.commandId),
    {ok:true,status:"not_recorded"});}
  finally{db.close();}
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:fx.stage.directory,expectedRestoreGeneration:fx.stage.restoreGeneration,
  });
  try{
    const issued=authority.issueWritable("alice");
    assert.ok(issued,"test actor must have a write-audience session");
    assert.deepEqual(authority.noteCreateRecovery(issued.sessionToken,cmd.commandId),
      {ok:true,status:"not_recorded"},"preflighted note-create receipt must be readable");
  }finally{authority.close();}
  const raw=spawnSync(process.execPath,[
    "--experimental-loader",path.join(process.cwd(),"scripts/target-staging-ts-loader.mjs"),
    path.join(process.cwd(),"scripts/target-staging-note-create-recovery-child.mjs"),
  ],{
    cwd:process.cwd(),encoding:"utf8",timeout:20_000,
    input:JSON.stringify({commandId:cmd.commandId}),
    env:{...process.env,
      AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:fx.stage.directory,
      AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:fx.stage.restoreGeneration,
      AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
      AI_EXECUTIVE_TARGET_STAGING_SESSION_HASH:"",
      LUMI_SYNTHETIC_CHILD_DIAG:"true",
    },
  });
  assert.equal(raw.status,0,"synthetic receipt child process failed: "+
    raw.stderr.slice(-1000)+" | stdout="+raw.stdout.slice(0,150));
  assert.deepEqual(JSON.parse(raw.stdout),{ok:true,status:"not_recorded"});
  const child=await readStagingNoteCreateRecoveryInChild({
    stagingDirectory:fx.stage.directory,
    expectedRestoreGeneration:fx.stage.restoreGeneration,ownerUserId:"alice",
  },cmd.commandId);
  assert.deepEqual(child,{ok:true,status:"not_recorded"},"child worker must report an absent receipt");
  const fresh=await checked(await RECOVER_CREATE(req("create-recovery",{
    commandId:cmd.commandId,
  })),200);
  assert.deepEqual(fresh,{status:"not_recorded"});
  assert.equal((await checked(await send(cmd),201)).noteId,cmd.noteId);
  assert.deepEqual(await checked(await RECOVER_CREATE(req("create-recovery",{
    commandId:cmd.commandId,
  })),200),{status:"committed"});
  // A foreign signed actor with the same UUID cannot learn any receipt.
  assert.deepEqual(await checked(await RECOVER_CREATE(req("create-recovery",{
    commandId:cmd.commandId,
  },bob)),200),{status:"not_recorded"});
  assert.deepEqual(await checked(await RECOVER_CREATE(req("create-recovery",{
    commandId:randomUUID(),
  })),200),{status:"not_recorded"});
  const response=await RECOVER_CREATE(req("create-recovery",{commandId:cmd.commandId}));
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.doesNotMatch(await response.text(),/Private idea|Some captured text|alice|bob|areaId|noteId|receiptKey/);
});
test("revoked or missing session, disabled write flag, and malformed create-recovery fail closed",async()=>{
  const fx=fixture(),bob=session(fx,"bob");
  const cmd=body(fx,{areaId:"bob-private"});
  assert.equal((await checked(await send(cmd,bob),201)).noteId,cmd.noteId);
  const hash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const live=durable.verifyDurableTargetStagingSessionLive(fx.store,hash);
  assert.ok(live?.sessionId);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store,live.sessionId).ok,true);
  assert.equal((await checked(await RECOVER_CREATE(req("create-recovery",{
    commandId:cmd.commandId,
  },bob)),401)).code,"session_revoked");
  assert.equal((await checked(await RECOVER_CREATE(req("create-recovery",{
    commandId:cmd.commandId,
  },"")),401)).error!==undefined,true);
  assert.equal((await checked(await RECOVER_CREATE(req("create-recovery",{
    commandId:"not-a-uuid",
  })),400)).error,"Invalid request");
  assert.equal((await checked(await RECOVER_CREATE(req("create-recovery",{
    commandId:cmd.commandId,extra:"leak",
  })),400)).error,"Invalid request");
  assert.equal((await checked(await RECOVER_CREATE(req("create-recovery",{
    commandId:cmd.commandId,
  },owner(),{"x-lumi-target-protocol":"0"})),400)).code,"protocol_unsupported");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED="false";
  assert.equal((await checked(await RECOVER_CREATE(req("create-recovery",{
    commandId:cmd.commandId,
  })),404)).error,"Not found");
  assert.equal((await checked(await PREVIEW_CREATE(req("create-preview",{
    areaId:fx.stage.unassignedAreaId,
  })),404)).error,"Not found");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED="true";
});
test("create-recovery child DTO is exact and content-free",()=>{
  const sample={ok:true,status:"committed",noteId:randomUUID(),areaId:"private"};
  const parsed=parseNoteCreateRecoveryReply(sample);
  assert.deepEqual(parsed?.status,"committed",JSON.stringify({
    keys:Object.keys(sample).sort().join(","),noteId:sample.noteId,
    uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sample.noteId),
    areaId:sample.areaId,
    bytes:Buffer.byteLength(sample.areaId,"utf8"),
    controls:/[\u0000-\u001f\u007f]/u.test(sample.areaId),
    hasOwn:["ok","status","noteId","areaId"].every(x=>Object.hasOwn(sample,x)),
  }));
  assert.deepEqual(parseNoteCreateRecoveryReply({ok:true,status:"not_recorded"}),
    {ok:true,status:"not_recorded"});
  for(const obj of [
    {ok:true,status:"committed",noteId:randomUUID()},
    {ok:true,status:"committed",noteId:randomUUID(),areaId:"shared",body:"secret"},
    {ok:true,status:"not_recorded",noteId:randomUUID()},
    {ok:false,reason:"access_denied"},
  ])assert.equal(parseNoteCreateRecoveryReply(obj),null);
});
