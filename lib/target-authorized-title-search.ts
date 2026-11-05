/**
 * R2d.4a — staging-only, title-only authorized search of projects, tasks
 * and notes. Internal read model; NEVER publish this page without an
 * actor-bound pinned preflight plus the atomic live Area + note-epoch guard.
 * Not production search, not HTTP, not a client-side ACL filter.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {eligibleGlobalTaskAreas,type TargetGlobalTaskScope} from "./target-global-task-read-model";
import {isReadableStagingProjectId} from "./target-project-id";
import type {HomeSummaryAreaEpoch} from "./target-my-plan-home-summary";
import type {GlobalNoteAreaEpoch} from "./target-global-note-read-model";
import type {TargetReadLinearization} from "./target-task-read-model";

export type AuthorizedSearchItem={
  kind:"project"|"task"|"note";id:string;title:string;
  areaId:string;areaKind:"private"|"shared";
  /** Tasks and notes may inherit an Area through a project. */
  projectId?:string|null;
};
export type AuthorizedSearchPage={
  scope:TargetGlobalTaskScope;items:AuthorizedSearchItem[];
  hasMore:boolean;nextOffset:number|null;revision:string;
  /** Server-only revocation witnesses; NEVER serialize to an HTTP client. */
  linearization:TargetReadLinearization;
  areaEpochs:HomeSummaryAreaEpoch[];
  noteAreaEpochs:GlobalNoteAreaEpoch[];
};
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL=/[\u0000-\u001f\u007f]/u;
const MAX_OFFSET=1_000_000;
const rank:Record<AuthorizedSearchItem["kind"],number>={
  project:0,task:1,note:2,
};
const validEpoch=(value:unknown):value is number=>
  typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
export function validAuthorizedTitleQuery(q:unknown):q is string{
  return typeof q==="string"&&q===q.trim()&&
    q.length>=2&&q.length<=80&&
    Buffer.byteLength(q,"utf8")<=256&&
    Buffer.from(q,"utf8").toString("utf8")===q&&!CONTROL.test(q);
}
/** SQLite LIKE treats % and _ as patterns. Search terms must be literal. */
function patternFor(q:string):string{
  return "%"+q.replace(/[!%_]/g,char=>"!"+char)+"%";
}
// One ACL-filtered SQL statement across all types. The predicates run BEFORE
// LIMIT/OFFSET, never after client-side filtering or separate HTTP requests.
// ASCII case-insensitive LIKE (SQLite built-in), without indexing/body search.
const SQL=[
  "WITH allowed AS (",
  " SELECT a.id AS areaId,a.kind AS areaKind FROM areas a",
  " JOIN workspaces w ON w.id=a.workspace_id",
  " JOIN identities actor ON actor.id=?",
  " LEFT JOIN area_members member ON member.area_id=a.id AND member.user_id=actor.id",
  " WHERE a.owner_user_id=w.owner_user_id",
  " AND ((a.kind='private' AND w.kind='personal' AND a.owner_user_id=actor.id)",
  "   OR (a.kind='shared' AND w.kind='shared' AND member.role IN ('viewer','editor','admin')))",
  " AND (?='all' OR (?='personal' AND a.kind='private') OR (?='shared' AND a.kind='shared'))",
  "), matches AS (",
  " SELECT 'project' AS kind,p.id AS id,p.title AS title,",
  " a.areaId AS areaId,a.areaKind AS areaKind,NULL AS projectId,0 AS rank",
  " FROM projects p JOIN allowed a ON a.areaId=p.area_id",
  " UNION ALL",
  " SELECT 'task',t.id,t.title,a.areaId,a.areaKind,t.project_id,1",
  " FROM tasks t LEFT JOIN projects p ON p.id=t.project_id",
  " JOIN allowed a ON a.areaId=COALESCE(t.area_id,p.area_id)",
  " WHERE ((t.project_id IS NULL AND t.area_id IS NOT NULL)",
  " OR (t.project_id IS NOT NULL AND t.area_id IS NULL AND p.id IS NOT NULL))",
  " UNION ALL",
  " SELECT 'note',n.id,n.title,a.areaId,a.areaKind,n.project_id,2",
  " FROM notes n LEFT JOIN projects p ON p.id=n.project_id",
  " JOIN allowed a ON a.areaId=COALESCE(n.area_id,p.area_id)",
  " WHERE ((n.project_id IS NULL AND n.area_id IS NOT NULL)",
  " OR (n.project_id IS NOT NULL AND n.area_id IS NULL AND p.id IS NOT NULL))",
  ")",
  "SELECT kind,id,title,areaId,areaKind,projectId FROM matches",
  "WHERE id NOT IN ('','.','..')",
  " AND length(CAST(id AS BLOB))<=512 AND instr(CAST(id AS BLOB),x'00')=0",
  " AND id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')",
  " AND (kind!='note' OR id=trim(id))",
  " AND length(trim(title))>0 AND length(CAST(title AS BLOB))<=4096",
  " AND title LIKE ? ESCAPE '!'",
  "ORDER BY id COLLATE BINARY ASC,rank ASC LIMIT ? OFFSET ?",
].join("\n");
type SearchRow=AuthorizedSearchItem&{projectId:string|null};

export function readAuthorizedTitleSearchPage(
  db:DatabaseSync,request:{
    actorUserId:string;scope:TargetGlobalTaskScope;query:string;
    limit:number;offset:number;restoreGeneration:string;
  },
):AuthorizedSearchPage|null{
  if(!request||typeof request.actorUserId!=="string"||
    !ACTOR.test(request.actorUserId)||
    !["all","personal","shared"].includes(request.scope)||
    !validAuthorizedTitleQuery(request.query)||
    !Number.isSafeInteger(request.limit)||request.limit<1||request.limit>50||
    !Number.isSafeInteger(request.offset)||request.offset<0||
    request.offset>MAX_OFFSET||
    typeof request.restoreGeneration!=="string"||
    !UUID.test(request.restoreGeneration))return null;
  try{
    const areaEpochs=eligibleGlobalTaskAreas(db,request.actorUserId,request.scope);
    if(!areaEpochs)return null;
    // Include note-only changes and empty readable Areas in EVERY revision.
    const selectNoteEpoch=db.prepare(
      "SELECT note_sync_revision AS noteSyncRevision FROM areas WHERE id=?");
    const noteAreaEpochs:GlobalNoteAreaEpoch[]=[];
    for(const area of areaEpochs){
      const epoch=selectNoteEpoch.get(area.areaId) as
        {noteSyncRevision:unknown}|undefined;
      if(!epoch||!validEpoch(epoch.noteSyncRevision))return null;
      noteAreaEpochs.push({areaId:area.areaId,
        noteSyncRevision:epoch.noteSyncRevision});
    }
    const rows=db.prepare(SQL).all(
      request.actorUserId,request.scope,request.scope,request.scope,
      patternFor(request.query),request.limit+1,request.offset,
    ) as unknown as SearchRow[];
    const allowed=new Map(areaEpochs.map(a=>[a.areaId,a.areaKind]));
    let previous:SearchRow|null=null;
    for(const row of rows){
      if(!["project","task","note"].includes(row.kind)||
        !isReadableStagingProjectId(row.id)||
        (row.kind==="note"&&row.id.trim()!==row.id)||
        typeof row.title!=="string"||!row.title.trim()||
        Buffer.byteLength(row.title,"utf8")>4096||
        typeof row.areaId!=="string"||
        !allowed.has(row.areaId)||allowed.get(row.areaId)!==row.areaKind||
        (row.kind==="project"&&row.projectId!==null)||
        (row.kind!=="project"&&row.projectId!==null&&
          !isReadableStagingProjectId(row.projectId)))
        return null;
      if(previous){
        const cmp=Buffer.compare(Buffer.from(previous.id),Buffer.from(row.id));
        if(cmp>0||(cmp===0&&rank[previous.kind]>=rank[row.kind]))
          return null;
      }
      previous=row;
    }
    const digest=createHash("sha256")
      .update("lumi:r2d:authorized-title-search:v1\0")
      .update(JSON.stringify([
        request.actorUserId,request.scope,request.query,
        request.restoreGeneration,
      ]));
    for(let i=0;i<areaEpochs.length;i++){
      const a=areaEpochs[i],n=noteAreaEpochs[i];
      digest.update("\0").update(JSON.stringify([
        a.areaId,a.areaKind,a.access,a.policyRevision,
        a.contentRevision,a.projectContentRevision,n.noteSyncRevision,
      ]));
    }
    const items:AuthorizedSearchItem[]=rows.slice(0,request.limit).map(row=>({
      kind:row.kind,id:row.id,title:row.title,areaId:row.areaId,
      areaKind:row.areaKind,
      ...(row.kind==="project"?{}:{projectId:row.projectId}),
    }));
    const hasMore=rows.length>request.limit;
    const nextOffset=hasMore?request.offset+items.length:null;
    if(nextOffset!==null&&nextOffset>MAX_OFFSET)return null;
    return {
      scope:request.scope,items,hasMore,nextOffset,
      revision:digest.digest("hex"),
      linearization:{actorUserId:request.actorUserId,
        areas:areaEpochs.map(a=>({areaId:a.areaId,areaKind:a.areaKind,
          access:a.access,policyRevision:a.policyRevision}))},
      areaEpochs,noteAreaEpochs,
    };
  }catch{return null;}
}
