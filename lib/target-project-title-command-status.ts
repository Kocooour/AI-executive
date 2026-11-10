/** Content-free actor-scoped project rename receipt check.
 * An absent receipt NEVER proves that a previously sent PATCH cannot commit.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {TARGET_STAGING_AUDIT_MAX_EVENTS} from "./target-store-bootstrap";
import {readAuthorizedProjectTasksPage} from "./target-project-task-read-model";
import {canWriteIsolatedTargetArea} from "./target-task-write-preflight";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
export type TargetProjectTitleRecovery=
 |{ok:true;status:"not_recorded"}
 |{ok:true;status:"committed";projectId:string;areaId:string}
 |{ok:false;reason:"unavailable"};

export function readTargetProjectTitleRecovery(
 db:DatabaseSync,actorUserId:string,commandId:string,restoreGeneration:string,
):TargetProjectTitleRecovery{
 const denied=():TargetProjectTitleRecovery=>({ok:false,reason:"unavailable"});
 if(!UUID.test(commandId)||!UUID.test(restoreGeneration)||!ACTOR.test(actorUserId))return denied();
 // The audit capacity is 4096 and the table is append-only. A larger scan or
 // an unreadable table fails closed instead of taking an unbounded read.
 const rows=db.prepare("SELECT receipt_key,project_id,area_id,restore_generation FROM project_title_audit WHERE actor_user_id=? LIMIT ?")
  .all(actorUserId,TARGET_STAGING_AUDIT_MAX_EVENTS+1) as {
    receipt_key:string;project_id:string;area_id:string;restore_generation:string;
  }[];
 if(rows.length>TARGET_STAGING_AUDIT_MAX_EVENTS)return denied();
 const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
 for(const row of rows){
   const key=digest(["lumi:project-title",actorUserId,row.project_id,commandId.toLowerCase()]);
   if(row.receipt_key!==key)continue;
   if(row.restore_generation.toLowerCase()!==restoreGeneration.toLowerCase()||
      !canWriteIsolatedTargetArea(db,actorUserId,row.area_id))return denied();
   const page=readAuthorizedProjectTasksPage(db,{
     actorUserId,projectId:row.project_id,limit:1,offset:0,restoreGeneration,
   });
   if(!page?.ok||page.page.project.areaId!==row.area_id||
     !["private-owner","editor","admin"].includes(page.page.linearization.areas[0]?.access??""))return denied();
   return {ok:true,status:"committed",projectId:row.project_id,areaId:row.area_id};
 }
 return {ok:true,status:"not_recorded"};
}
