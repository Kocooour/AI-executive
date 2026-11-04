/**
 * R2d.3m.3 — actor-authorized global project index, staging only.
 * Unlike My Plan, global Vše includes every project readable to the actor,
 * including shared projects with no tasks and viewer-only membership.
 * Called ONLY inside one canonical preflighted pinned SQLite read snapshot.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {eligibleGlobalTaskAreas,type TargetGlobalTaskScope} from "./target-global-task-read-model";
import {isReadableStagingProjectId} from "./target-project-id";
import type {HomeSummaryAreaEpoch} from "./target-my-plan-home-summary";
import type {TargetReadLinearization} from "./target-task-read-model";

export type TargetGlobalProject={
  id:string;title:string;areaId:string;areaKind:"private"|"shared";
};
export type TargetGlobalProjectPage={
  scope:TargetGlobalTaskScope;projects:TargetGlobalProject[];
  hasMore:boolean;revision:string;
  /** Internal-only witnesses: do not expose in an HTTP DTO. */
  linearization:TargetReadLinearization;
  areaEpochs:HomeSummaryAreaEpoch[];
};
type Row=TargetGlobalProject;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Mirror the existing target project-index policy. Malformed IDs must be
// rejected in SQLite BEFORE applying LIMIT/OFFSET, not after hydration.
const readableProjectIdSql=`p.id NOT IN ('','.','..')
  AND length(CAST(p.id AS BLOB)) <= 512
  AND instr(CAST(p.id AS BLOB),x'00')=0
  AND p.id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')`;

export function readAuthorizedGlobalProjectPage(
  db:DatabaseSync,request:{
    actorUserId:string;scope:TargetGlobalTaskScope;
    limit:number;offset:number;restoreGeneration:string;
  },
):TargetGlobalProjectPage|null{
  if(!request||typeof request.actorUserId!=="string"||
    !ACTOR.test(request.actorUserId)||
    !["all","personal","shared"].includes(request.scope)||
    !Number.isSafeInteger(request.limit)||request.limit<1||request.limit>100||
    !Number.isSafeInteger(request.offset)||request.offset<0||
    request.offset>1_000_000||
    typeof request.restoreGeneration!=="string"||
    !UUID.test(request.restoreGeneration))return null;
  try{
    // This enumerates ALL eligible Areas, even empty ones. Any membership
    // change is therefore reflected in the global revision and live guard.
    const areaEpochs=eligibleGlobalTaskAreas(db,request.actorUserId,request.scope);
    if(!areaEpochs)return null;
    const rows=db.prepare(`SELECT p.id AS id,p.title AS title,
      a.id AS areaId,a.kind AS areaKind
      FROM projects p JOIN areas a ON a.id=p.area_id
      JOIN workspaces w ON w.id=a.workspace_id
      JOIN identities actor ON actor.id=?
      LEFT JOIN area_members member
        ON member.area_id=a.id AND member.user_id=actor.id
      WHERE a.owner_user_id=w.owner_user_id
        AND ((a.kind='private' AND w.kind='personal'
              AND w.owner_user_id=actor.id)
          OR (a.kind='shared' AND w.kind='shared'
              AND member.role IN ('viewer','editor','admin')))
        AND (?='all' OR (?='personal' AND a.kind='private')
             OR (?='shared' AND a.kind='shared'))
        AND ${readableProjectIdSql}
      ORDER BY p.id COLLATE BINARY ASC
      LIMIT ? OFFSET ?`).all(
        request.actorUserId,request.scope,request.scope,request.scope,
        request.limit+1,request.offset,
      ) as unknown as Row[];
    const areaById=new Map(areaEpochs.map(a=>[a.areaId,a]));
    if(rows.some(r=>!isReadableStagingProjectId(r.id)||
      typeof r.title!=="string"||typeof r.areaId!=="string"||
      !areaById.has(r.areaId)||
      (r.areaKind!=="private"&&r.areaKind!=="shared")||
      areaById.get(r.areaId)?.areaKind!==r.areaKind))return null;
    const revision=createHash("sha256")
      .update("lumi:r2d:global-project-index:v1\0")
      .update(JSON.stringify([
        request.actorUserId,request.scope,request.restoreGeneration,
      ]));
    for(const a of areaEpochs)revision.update("\0").update(JSON.stringify([
      a.areaId,a.areaKind,a.access,a.policyRevision,
      a.projectContentRevision,a.contentRevision,
    ]));
    return {
      scope:request.scope,
      projects:rows.slice(0,request.limit).map(r=>({
        id:r.id,title:r.title,areaId:r.areaId,areaKind:r.areaKind,
      })),
      hasMore:rows.length>request.limit,
      revision:revision.digest("hex"),
      linearization:{
        actorUserId:request.actorUserId,
        areas:areaEpochs.map(a=>({
          areaId:a.areaId,areaKind:a.areaKind,access:a.access,
          policyRevision:a.policyRevision,
        })),
      },
      areaEpochs,
    };
  }catch{return null;}
}
