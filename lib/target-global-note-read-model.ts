/**
 * R2d.3m.5 — internal actor-authorized global note-title index.
 *
 * Staging only: caller MUST hold one signed-actor, canonical preflighted
 * pinned read snapshot. The index exposes no bodies, foreign owners,
 * members or private plan metadata. HTTP will require a live note-sync
 * epoch + full eligible-Area guard before any title is released.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {eligibleGlobalTaskAreas,type TargetGlobalTaskScope} from "./target-global-task-read-model";
import type {HomeSummaryAreaEpoch} from "./target-my-plan-home-summary";
import type {TargetReadLinearization} from "./target-task-read-model";
import {isReadableStagingProjectId} from "./target-project-id";

export type GlobalNoteAreaEpoch={areaId:string;noteSyncRevision:number};
export type TargetGlobalNote={
  id:string;title:string;projectId:string|null;
  areaId:string;areaKind:"private"|"shared";revision:number;
};
export type TargetGlobalNotePage={
  scope:TargetGlobalTaskScope;notes:TargetGlobalNote[];
  hasMore:boolean;revision:string;
  /** Internal only: complete current Area ACL/epochs, including empty Areas. */
  linearization:TargetReadLinearization;
  areaEpochs:HomeSummaryAreaEpoch[];
  /** Internal only: note-specific content epochs not in task/project epochs. */
  noteAreaEpochs:GlobalNoteAreaEpoch[];
};
type Row=TargetGlobalNote;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safe=(x:unknown)=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=0;
const validId=(x:unknown)=>isReadableStagingProjectId(x)&&
  typeof x==="string"&&x.trim()===x;

/** Exclude malformed note IDs BEFORE the LIMIT/OFFSET, as in note bootstrap. */
const validNoteSql=`n.id NOT IN ('','.','..')
  AND n.id=trim(n.id)
  AND length(CAST(n.id AS BLOB))<=512
  AND instr(CAST(n.id AS BLOB),x'00')=0
  AND n.id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')`;

export function readAuthorizedGlobalNotePage(
  db:DatabaseSync,request:{
    actorUserId:string;scope:TargetGlobalTaskScope;
    limit:number;offset:number;restoreGeneration:string;
  },
):TargetGlobalNotePage|null{
  if(!request||typeof request.actorUserId!=="string"||!ACTOR.test(request.actorUserId)||
    !["all","personal","shared"].includes(request.scope)||
    !Number.isSafeInteger(request.limit)||request.limit<1||request.limit>100||
    !Number.isSafeInteger(request.offset)||request.offset<0||request.offset>1_000_000||
    typeof request.restoreGeneration!=="string"||!UUID.test(request.restoreGeneration))
    return null;
  try{
    // Covers ALL readable Areas, even when no note belongs to them.
    const areaEpochs=eligibleGlobalTaskAreas(db,request.actorUserId,request.scope);
    if(!areaEpochs)return null;
    // area.note_sync_revision is independent from task/project content epochs.
    // A note edit, insertion, deletion or Area move must invalidate every page.
    const noteEpoch=db.prepare(
      "SELECT note_sync_revision AS noteSyncRevision FROM areas WHERE id=?");
    const noteAreaEpochs:GlobalNoteAreaEpoch[]=[];
    for(const area of areaEpochs){
      const row=noteEpoch.get(area.areaId) as {noteSyncRevision:unknown}|undefined;
      if(!row||!safe(row.noteSyncRevision))return null;
      noteAreaEpochs.push({areaId:area.areaId,
        noteSyncRevision:row.noteSyncRevision as number});
    }
    const rows=db.prepare(`SELECT n.id AS id,n.title AS title,
      n.project_id AS projectId,a.id AS areaId,a.kind AS areaKind,
      n.revision AS revision
      FROM notes n LEFT JOIN projects p ON p.id=n.project_id
      JOIN areas a ON a.id=COALESCE(n.area_id,p.area_id)
      JOIN workspaces w ON w.id=a.workspace_id
      JOIN identities actor ON actor.id=?
      LEFT JOIN area_members member ON member.area_id=a.id AND member.user_id=actor.id
      WHERE ((n.project_id IS NULL AND n.area_id IS NOT NULL)
          OR (n.project_id IS NOT NULL AND n.area_id IS NULL AND p.id IS NOT NULL))
        AND a.owner_user_id=w.owner_user_id
        AND ((a.kind='private' AND w.kind='personal' AND w.owner_user_id=actor.id)
          OR (a.kind='shared' AND w.kind='shared'
              AND member.role IN ('viewer','editor','admin')))
        AND (?='all' OR (?='personal' AND a.kind='private')
          OR (?='shared' AND a.kind='shared'))
        AND ${validNoteSql}
        AND length(trim(n.title))>0
        AND length(CAST(n.title AS BLOB))<=4096
      ORDER BY n.id COLLATE BINARY ASC
      LIMIT ? OFFSET ?`).all(
        request.actorUserId,request.scope,request.scope,request.scope,
        request.limit+1,request.offset,
      ) as unknown as Row[];
    const areaMap=new Map(areaEpochs.map(a=>[a.areaId,a]));
    let previous:Buffer|null=null;
    for(const row of rows){
      if(!validId(row.id)||!validId(row.areaId)||
        (row.projectId!==null&&!validId(row.projectId))||
        typeof row.title!=="string"||!row.title.trim()||
        Buffer.byteLength(row.title,"utf8")>4096||
        !safe(row.revision)||
        !areaMap.has(row.areaId)||row.areaKind!==areaMap.get(row.areaId)?.areaKind)
        return null;
      const bytes=Buffer.from(row.id);
      if(previous&&Buffer.compare(previous,bytes)>=0)return null;
      previous=bytes;
    }
    const digest=createHash("sha256")
      .update("lumi:r2d:global-note-index:v1\0")
      .update(JSON.stringify([request.actorUserId,request.scope,request.restoreGeneration]));
    for(let i=0;i<areaEpochs.length;i++){
      const a=areaEpochs[i],n=noteAreaEpochs[i];
      digest.update("\0").update(JSON.stringify([
        a.areaId,a.areaKind,a.access,a.policyRevision,
        a.contentRevision,a.projectContentRevision,n.noteSyncRevision,
      ]));
    }
    return {
      scope:request.scope,
      notes:rows.slice(0,request.limit).map(r=>({
        id:r.id,title:r.title,projectId:r.projectId,
        areaId:r.areaId,areaKind:r.areaKind,revision:r.revision,
      })),
      hasMore:rows.length>request.limit,revision:digest.digest("hex"),
      linearization:{
        actorUserId:request.actorUserId,
        areas:areaEpochs.map(a=>({areaId:a.areaId,areaKind:a.areaKind,
          access:a.access,policyRevision:a.policyRevision})),
      },
      areaEpochs,noteAreaEpochs,
    };
  }catch{return null;}
}
