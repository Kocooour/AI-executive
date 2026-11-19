/** Explicit C-3a operator upgrade of an already preflighted isolated v26
 * SQLite store. No startup hook, no HTTP route and no legacy store access.
 * The pinned helper validates the existing v26 schema and journal/witness,
 * serializes the DDL with normal writes and journals the single v26→v27 commit.
 */
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {migrateTargetInboxTriageInTransaction} from "./target-inbox-triage";

export type TargetInboxUpgradeResult=
  |{ok:true;result:"upgraded"|"already_applied"}
  |{ok:false;reason:"unavailable"|"write_failed"|"uncertain"};

export function upgradeTargetInboxTriagePinned(
  store:TargetStagingReadStore,explicitOperatorApproval:boolean,
):TargetInboxUpgradeResult{
  if(explicitOperatorApproval!==true)return {ok:false,reason:"unavailable"};
  return withPinnedTargetStagingWrite<TargetInboxUpgradeResult>(store,ctx=>{
    const version=(ctx.db.prepare("SELECT value FROM metadata WHERE key='schema_version'")
      .get() as {value:string}|undefined)?.value;
    if(version==="27")return {ok:true,result:"already_applied"};
    if(version!=="26")return {ok:false,reason:"unavailable"};
    if(!ctx.stillPinned())return {ok:false,reason:"unavailable"};
    if(migrateTargetInboxTriageInTransaction(ctx.db)!=="applied")
      return {ok:false,reason:"write_failed"};
    // A schema change has no user Process receipt and must not issue a
    // per-task processed event or R5 notification.
    const confirmed=ctx.commit({kind:"schema_upgrade",payload:{from:26,to:27}});
    return confirmed?{ok:true,result:"upgraded"}:{ok:false,reason:"uncertain"};
  },()=>({ok:false,reason:"unavailable"}),()=>({ok:false,reason:"write_failed"}),5000);
}
