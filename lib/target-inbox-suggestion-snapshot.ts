/**
 * C-3b: actor-scoped candidate selection on one caller-pinned, read-only v27
 * target SQLite snapshot. NEVER accept a caller-provided candidate allowlist.
 *
 * This is a core read primitive, not an HTTP route or session authorization:
 * caller must authenticate actor, preflight/pin the store, and recheck the live
 * session/ACL/restore generation before displaying the result.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {targetStoreRestoreGeneration,targetTaskWriteRevision} from "./target-task-write-preflight";
import {validInboxSuggestionSnapshot} from "./target-inbox-suggestions";
import type {InboxSuggestionSnapshot} from "./target-inbox-suggestions";

const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const TASK_ID=/^[^\u0000-\u001f\u007f]{1,512}$/u;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CANDIDATES=128;

type AreaRow={
  id:string;name:string;revision:number;contentRevision:number;
  projectContentRevision:number;
};
type ProjectRow={id:string;name:string;areaId:string;revision:number};
type TaskRow={
  id:string;taskTitle:string;taskRevision:number;triageRevision:number;
  triageState:string;taskStatus:string;currentAreaId:string;
  currentProjectId:string|null;
};
type WhenRow={whenOn:string;revision:number};
type EpochRow={revision:number};

export type AuthorizedInboxSuggestionSnapshot={
  readonly snapshot:InboxSuggestionSnapshot;
  readonly taskId:string;
  readonly taskRevision:number;
  readonly triageRevision:number;
  readonly restoreGeneration:string;
  readonly taskWriteRevision:string;
  /** Private plan from ONLY the current actor, never shared due_on. */
  readonly personalWhenOn:string|null;
  readonly personalWhenRevision:number|null;
  readonly personalPlanEpoch:number;
  /** SHA-256 of the full candidate set and all relevant mutable witnesses. */
  readonly candidateFingerprint:string;
};

const epoch=(n:unknown):n is number=>typeof n==="number"&&
  Number.isSafeInteger(n)&&n>=0;
const goodDay=(s:unknown):s is string=>typeof s==="string"&&
  /^\d{4}-\d{2}-\d{2}$/.test(s)&&
  !Number.isNaN(Date.parse(s+"T00:00:00Z"))&&
  new Date(s+"T00:00:00Z").toISOString().slice(0,10)===s;

/**
 * Source task MUST be an unprocessed, open, actor-owned private task.
 * Uses LIMIT max+1 on each full candidate set: never silently omit candidates
 * (which could turn a real ambiguity into a false unique recommendation).
 *
 * v27 projects have no completion/status column. The complete set of live
 * actor-private projects is therefore the only representable "open" set;
 * do not infer status from child-task completion or accept a client filter.
 */
export function readAuthorizedInboxSuggestionSnapshot(
  db:DatabaseSync, actorUserId:string, taskId:string,
  expectedRestoreGeneration:string,
):AuthorizedInboxSuggestionSnapshot|null{
  if(!db||typeof actorUserId!=="string"||!ACTOR.test(actorUserId)||
     typeof taskId!=="string"||!TASK_ID.test(taskId)||taskId==="."||taskId===".."||
     typeof expectedRestoreGeneration!=="string"||
     !UUID.test(expectedRestoreGeneration))return null;
  try{
    const restoreGeneration=targetStoreRestoreGeneration(db);
    if(!restoreGeneration||
       restoreGeneration!==expectedRestoreGeneration.toLowerCase())return null;
    const areas=db.prepare(`SELECT a.id AS id,a.title AS name,
        a.policy_revision AS revision,a.content_revision AS contentRevision,
        a.project_content_revision AS projectContentRevision
      FROM areas a JOIN workspaces w ON w.id=a.workspace_id
      JOIN identities actor ON actor.id=?
      WHERE a.kind='private' AND w.kind='personal'
        AND a.owner_user_id=actor.id AND w.owner_user_id=actor.id
      ORDER BY a.id COLLATE BINARY LIMIT ?`)
      .all(actorUserId,MAX_CANDIDATES+1) as AreaRow[];
    if(!areas.length||areas.length>MAX_CANDIDATES||areas.some(a=>
        !epoch(a.revision)||!epoch(a.contentRevision)||
        !epoch(a.projectContentRevision)))return null;

    const projects=db.prepare(`SELECT p.id AS id,p.title AS name,
        p.area_id AS areaId,p.revision AS revision
      FROM projects p JOIN areas a ON a.id=p.area_id
      JOIN workspaces w ON w.id=a.workspace_id
      JOIN identities actor ON actor.id=?
      WHERE a.kind='private' AND w.kind='personal'
        AND a.owner_user_id=actor.id AND w.owner_user_id=actor.id
      ORDER BY p.id COLLATE BINARY LIMIT ?`)
      .all(actorUserId,MAX_CANDIDATES+1) as ProjectRow[];
    if(projects.length>MAX_CANDIDATES)return null;

    const task=db.prepare(`SELECT t.id AS id,t.title AS taskTitle,
        t.revision AS taskRevision,t.triage_revision AS triageRevision,
        t.triage_state AS triageState,t.status AS taskStatus,
        a.id AS currentAreaId,t.project_id AS currentProjectId
      FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
      JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
      JOIN workspaces w ON w.id=a.workspace_id
      JOIN identities actor ON actor.id=?
      WHERE t.id=? AND t.status='open' AND t.triage_state='unprocessed'
        AND ((t.project_id IS NULL AND t.area_id IS NOT NULL)
          OR (t.project_id IS NOT NULL AND t.area_id IS NULL AND p.id IS NOT NULL))
        AND a.kind='private' AND w.kind='personal'
        AND a.owner_user_id=actor.id AND w.owner_user_id=actor.id
      LIMIT 1`).get(actorUserId,taskId) as TaskRow|undefined;
    if(!task||task.id!==taskId||!epoch(task.taskRevision)||
       !epoch(task.triageRevision)||
       task.triageState!=="unprocessed"||task.taskStatus!=="open")return null;
    // A source project outside this actor-private candidate set is impossible
    // for a valid private task. Fail closed rather than guessing its Area.
    if(task.currentProjectId!==null&&
       !projects.some(p=>p.id===task.currentProjectId&&p.areaId===task.currentAreaId))
      return null;

    const personal=db.prepare(`SELECT when_on AS whenOn,revision
      FROM personal_task_plans WHERE user_id=? AND task_id=?`)
      .get(actorUserId,taskId) as WhenRow|undefined;
    if(personal&&(!goodDay(personal.whenOn)||!epoch(personal.revision)))return null;
    const planEpoch=db.prepare(`SELECT revision FROM personal_plan_epochs
      WHERE user_id=?`).get(actorUserId) as EpochRow|undefined;
    if(!planEpoch||!epoch(planEpoch.revision))return null;
    const snapshot:InboxSuggestionSnapshot={
      taskTitle:task.taskTitle,currentAreaId:task.currentAreaId,
      currentProjectId:task.currentProjectId,
      privateAreas:areas.map(a=>({id:a.id,name:a.name,revision:a.revision})),
      privateOpenProjects:projects.map(p=>({
        id:p.id,name:p.name,areaId:p.areaId,revision:p.revision,
      })),
    };
    if(!validInboxSuggestionSnapshot(snapshot))return null;
    const taskWriteRevision=targetTaskWriteRevision(db,taskId);
    if(!taskWriteRevision||!/^[a-f0-9]{64}$/.test(taskWriteRevision))return null;
    const candidateFingerprint=createHash("sha256")
      .update("lumi:c3b:authorized-candidates:v1\0")
      .update(JSON.stringify([
        actorUserId,taskId,restoreGeneration,taskWriteRevision,
        task.taskRevision,task.triageRevision,
        personal?.whenOn??null,personal?.revision??null,planEpoch.revision,
        areas.map(a=>[a.id,a.name,a.revision,a.contentRevision,a.projectContentRevision]),
        projects.map(p=>[p.id,p.name,p.areaId,p.revision]),
      ])).digest("hex");
    return {snapshot,taskId,taskRevision:task.taskRevision,
      triageRevision:task.triageRevision,restoreGeneration,taskWriteRevision,
      personalWhenOn:personal?.whenOn??null,
      personalWhenRevision:personal?.revision??null,
      personalPlanEpoch:planEpoch.revision,candidateFingerprint};
  }catch{return null;}
}
