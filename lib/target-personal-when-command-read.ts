/** R2d.3k.4b: single-snapshot, current-writer-only private plan CAS preview.
 * No actor, Area, session or epoch is accepted from the HTTP request.
 */
import type {DatabaseSync} from "node:sqlite";
import {readAuthorizedTemporalTaskDetail} from "./target-task-temporal-read-model";
import type {TargetReadLinearization} from "./target-task-read-model";
import type {TargetTemporalTaskLiveGuard} from "./target-task-temporal-read-model";
import {targetTaskWriteRevision,checkTargetTaskWriteContract} from "./target-task-write-preflight";
import {validTargetDueOn} from "./target-task-temporal-due-on-writer";

export type PersonalWhenCommandPreview={
  expectedRevision:string;
  expectedPrivateEpoch:number;
  expectedPlanRevision:number|null;
  whenOn:string|null;
  writeAreaId:string;
  /** Internal witness, never returned to the HTTP caller. */
  linearization:TargetReadLinearization;
  guard:TargetTemporalTaskLiveGuard;
};
const epoch=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;

/** Read/write permission, current shared assignment, and the full CAS state
 * are checked on ONE already-preflighted pinned SQLite read transaction. */
export function readAuthorizedPersonalWhenCommandPreview(
  db:DatabaseSync, actor:string,taskId:string,restoreGeneration:string,
):PersonalWhenCommandPreview|null {
  try {
    const detail=readAuthorizedTemporalTaskDetail(db,actor,taskId);
    if(!detail||detail.task.status!=="open")return null;
    const access=detail.linearization.areas[0]?.access;
    if(access!=="private-owner"&&access!=="editor"&&access!=="admin")return null;
    if(detail.task.areaKind==="shared"&&detail.task.assignedToMe!==true)return null;
    if(detail.task.areaKind==="private"&&access!=="private-owner")return null;
    const contract=checkTargetTaskWriteContract(db,actor,{
      taskId,writeAreaId:detail.task.areaId,restoreGeneration,
    });
    if(contract.ok!==true)return null;
    const expectedRevision=targetTaskWriteRevision(db,taskId);
    if(!expectedRevision||!/^[a-f0-9]{64}$/.test(expectedRevision))return null;
    const row=db.prepare("SELECT revision FROM personal_plan_epochs WHERE user_id=?")
      .get(actor) as {revision:number}|undefined;
    if(!row||!epoch(row.revision))return null;
    const plan=db.prepare(
      "SELECT when_on AS whenOn,revision FROM personal_task_plans WHERE user_id=? AND task_id=?"
    ).get(actor,taskId) as {whenOn:string;revision:number}|undefined;
    if(plan&&(!epoch(plan.revision)||typeof plan.whenOn!=="string"||
        !validTargetDueOn(plan.whenOn)))return null;
    return {expectedRevision,expectedPrivateEpoch:row.revision,
      expectedPlanRevision:plan?.revision??null,whenOn:plan?.whenOn??null,
      writeAreaId:detail.task.areaId,
      linearization:detail.linearization,guard:detail.guard};
  }catch{return null;}
}
