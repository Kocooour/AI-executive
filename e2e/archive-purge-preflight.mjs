// #501: synthetic ONE-RUN purge and real server-store restart, before the
// personal-v1 browser server starts. Run only from playwright.config.ts in
// the throwaway lumi-e2e-* directory, never on production.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "../lib/server-store.ts";
import { ARCHIVE_TABLES, purgeArchive } from "../scripts/archive-purge.mjs";

const [runDirectory] = process.argv.slice(2);
if (!runDirectory || !path.isAbsolute(runDirectory) ||
    !path.basename(runDirectory).startsWith("lumi-e2e-") ||
    !realpathSync(runDirectory).startsWith(realpathSync(os.tmpdir()) + path.sep)) {
  throw new Error("archive-preflight-requires-isolated-run-directory");
}
const dataDirectory = path.join(runDirectory, "data");
const databasePath = path.join(dataDirectory, "store.sqlite");
const backupDirectory = path.join(runDirectory, "synthetic-deploy-backups");
mkdirSync(dataDirectory, { recursive:true, mode:0o700 });
mkdirSync(path.join(backupDirectory,"deploy-abcdefgh"), { recursive:true });
if (existsSync(databasePath)) throw new Error("synthetic-legacy-db-must-not-preexist");
const db = new DatabaseSync(databasePath);
try {
  applySchema(db);
  db.prepare("INSERT INTO metadata(key,value) VALUES('revision','42')").run();
  db.prepare("INSERT INTO metadata(key,value) VALUES('updatedAt','42')").run();
  const insertEntity=db.prepare("INSERT INTO entities(id,payload,updated_at) VALUES(?,?,?)");
  insertEntity.run("workspace:personal", JSON.stringify({
    id:"workspace:personal", type:"workspace", title:"Synthetic",
    workspaceId:"personal", status:"active", properties:{},
    createdAt:1,updatedAt:1,
  }),1);
  insertEntity.run("task:e2e-archive",JSON.stringify({
    id:"task:e2e-archive", type:"task", title:"Synthetic archive task",
    workspaceId:"personal", status:"active",properties:{},
    createdAt:1, updatedAt:1,
  }),1);
  db.prepare("INSERT INTO relations(id,payload,created_at) VALUES(?,?,?)").run(
    "relation:e2e-archive",JSON.stringify({id:"relation:e2e-archive",
      workspaceId:"personal",sourceEntityId:"workspace:personal",
      targetEntityId:"task:e2e-archive",relationType:"belongs_to",createdAt:1}),1);
  db.prepare("INSERT INTO tombstones(id,deleted_at) VALUES(?,?)").run("task:deleted",1);
  db.prepare("INSERT INTO note_revisions(id,note_id,workspace_id,revision,title,content,content_sha256,origin,store_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("revision:e2e","note:old","personal",1,"Synthetic","Synthetic","a".repeat(64),"test",1,1);
  db.prepare("INSERT INTO passkey_credentials(credential_id,public_key,counter,transports,device_type,backed_up,rp_id,label,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("passkey:e2e",Buffer.from([1,2,3]),0,"[]","singleDevice",0,"example.test","Synthetic passkey",1);
  db.prepare("INSERT INTO mail_accounts(id,provider,workspace_id,email,encrypted_refresh_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run("mail:e2e","gmail","personal","test@example.invalid","encrypted-synthetic",1,1);
  db.prepare("INSERT INTO calendar_sources(id,workspace_id,provider,label,encrypted_url,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("calendar:e2e","personal","ical","Synthetic","encrypted","active",1,1);
  db.prepare("INSERT INTO work_sessions(id,workspace_id,task_id,state,revision,accumulated_ms,running_since,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("session:e2e","personal","task:e2e-archive","completed",1,100,null,1,1,1);
} finally { db.close(); }

const protectedTables=["passkey_credentials","mail_accounts","calendar_sources","work_sessions","metadata","schema_migrations"];
const countRows=database=>Object.fromEntries(ARCHIVE_TABLES.map(table=>[
  table,Number(database.prepare('SELECT COUNT(*) AS n FROM "'+table+'"').get().n)]));
const snapshot=database=>Object.fromEntries(protectedTables.map(table=>[
  table,createHash("sha256").update(JSON.stringify(database.prepare(
    'SELECT * FROM "'+table+'" ORDER BY rowid').all())).digest("hex")]));
const readDb=fn=>{
  const database=new DatabaseSync(databasePath,{readOnly:true});
  try{return fn(database);}finally{database.close();}
};
const protectedBefore=readDb(snapshot);
const options={dbPath:databasePath,backupDirectory,actor:"ai-executive",state:"inactive"};
const dry=purgeArchive({...options,dryRun:true});
assert.deepEqual(dry.before,{note_revisions:1,relations:1,tombstones:1,entities:2});
const applied=purgeArchive(options);
assert.deepEqual(applied.before,dry.before);
assert.ok(Object.values(applied.after).every(x=>x===0));
assert.deepEqual(readDb(snapshot),protectedBefore);

// Restart the REAL server-store code in a fresh process while the operator's
// service is stopped; this is what previously recreated workspace:personal.
execFileSync(process.execPath,[
  "--experimental-loader","./scripts/target-staging-ts-loader.mjs",
  "--input-type=module","-e",
  "import { getDatabase } from './lib/server-store.ts'; getDatabase().close();",
],{cwd:process.cwd(),env:{...process.env,AI_EXECUTIVE_DATA_DIR:dataDirectory},
  stdio:["ignore","pipe","pipe"],timeout:20_000});
const afterStartup=readDb(countRows);
assert.ok(Object.values(afterStartup).every(x=>x===0),"startup must never re-seed Archive");
assert.deepEqual(readDb(snapshot),protectedBefore,"startup must preserve protected tables");

// A second operator execution, after startup and shutdown, remains zero.
const second=purgeArchive(options);
assert.ok(Object.values(second.before).every(x=>x===0));
assert.ok(Object.values(second.after).every(x=>x===0));
const witness={databasePath,protectedTables,protectedBefore,
  firstBefore:dry.before,afterApply:applied.after,afterStartup,
  secondBefore:second.before,secondAfter:second.after};
writeFileSync(path.join(runDirectory,"archive-purge-preflight.json"),
  JSON.stringify(witness),{mode:0o600});
