#!/usr/bin/env node
/** C-3a one-shot operator command. Not invoked at boot or by HTTP.
 * Requires a separately verified target directory and exact generation.
 * Never opens the legacy data store or resets any target data. */
import path from "node:path";
import {inspectIsolatedTargetStore} from "../lib/target-store-preflight.ts";
import {upgradeTargetInboxTriagePinned} from "../lib/target-inbox-upgrade.ts";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mode=process.argv.length===3?process.argv[2]:null;
const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
const expectedOwnerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
if(!["--check","--apply"].includes(mode)||!stagingDirectory||
  !path.isAbsolute(stagingDirectory)||!expectedRestoreGeneration||
  !uuid.test(expectedRestoreGeneration)||!expectedOwnerUserId){
  process.stderr.write("Usage: set isolated target directory, owner and generation; pass --check or --apply\n");
  process.exitCode=2;
}else{
  const preflight=inspectIsolatedTargetStore({
    stagingDirectory,expectedRestoreGeneration,expectedOwnerUserId,mode:"r2-model",
  });
  if(!preflight.ok){
    process.stderr.write("Target preflight refused (no changes applied).\n");
    process.exitCode=1;
  }else if(mode==="--check"){
    process.stdout.write("C-3a target preflight OK; this check does not modify data.\n");
  }else{
    // Operator invoked --apply explicitly after verified backup/approval.
    const result=upgradeTargetInboxTriagePinned(
      {stagingDirectory,expectedRestoreGeneration},true);
    if(result.ok)process.stdout.write(
      result.result==="upgraded"?"C-3a schema upgrade confirmed.\n":"C-3a schema already installed.\n");
    else{
      process.stderr.write("C-3a upgrade not confirmed; inspect trust/journal before retry.\n");
      process.exitCode=1;
    }
  }
}
