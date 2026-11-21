/**
 * Opt-in C-3a browser acceptance helper: delete through the ACTUAL pinned
 * target writer, not raw SQL. Never read or mutate a production target store.
 * Spawned with scripts/target-staging-ts-loader.mjs by Playwright.
 */
import {randomUUID} from "node:crypto";
import {realpathSync} from "node:fs";
import path from "node:path";

const fail=message=>{process.stderr.write("target-inbox-delete-child: "+message+"\n");process.exit(2);};
const [taskId]=process.argv.slice(2);
const fixture=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null");
const runDir=process.env.LUMI_E2E_RUN_DIR;
if(process.env.LUMI_TARGET_INBOX_E2E!=="true"||
    !taskId||!fixture||!runDir||!path.isAbsolute(runDir)||
    !path.basename(runDir).startsWith("lumi-e2e-")||
    typeof fixture.directory!=="string"||
    typeof fixture.ownerUserId!=="string"||
    typeof fixture.restoreGeneration!=="string")fail("invalid opt-in fixture");
const run=realpathSync(runDir),staging=realpathSync(fixture.directory);
if(staging!==path.join(run,"target-store"))fail("fixture escapes isolated run directory");

const {TargetStagingSessionAuthority}=
  await import("../lib/target-staging-session-authority.ts");
const authority=new TargetStagingSessionAuthority({
  stagingDirectory:staging,expectedRestoreGeneration:fixture.restoreGeneration,
});
try{
  const token=authority.issueWritable(fixture.ownerUserId).sessionToken;
  const preview=authority.previewTaskTitleEdit(token,{taskId});
  if(preview.ok!==true)fail("task delete preview unavailable");
  const {DatabaseSync}=await import("node:sqlite");
  const db=new DatabaseSync(path.join(staging,"lumi-target.sqlite"));
  let areaId;
  try{
    const row=db.prepare(`SELECT COALESCE(t.area_id,p.area_id) AS areaId
      FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?`)
      .get(taskId);
    areaId=row?.areaId;
  }finally{db.close();}
  if(typeof areaId!=="string")fail("task Area unavailable");
  const result=authority.deleteTask(token,{
    commandId:randomUUID(),taskId,expectedRevision:preview.snapshotRevision,
    writeAreaId:areaId,restoreGeneration:fixture.restoreGeneration,
  });
  if(result.ok!==true)fail("pinned task delete failed: "+JSON.stringify(result));
  process.stdout.write(JSON.stringify(result));
}finally{authority.close();}
