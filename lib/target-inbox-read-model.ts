/** C-3a: actor-scoped, bounded Inbox selector for a single pinned read-only
 * target SQLite snapshot. Actor identity MUST come from verifiedActor on the
 * server; this is not an unauthenticated HTTP endpoint. No legacy tables. */
import type {DatabaseSync} from "node:sqlite";

export type TargetInboxTask={
  id:string;title:string;projectId:string|null;areaId:string;
  completion:"open"|"completed";taskRevision:number;triageRevision:number;
};
export type TargetInboxPage={
  tasks:TargetInboxTask[];count:number;hasMore:boolean;afterTaskId:string|null;
};
const AUTH_FROM=`
 FROM task_triage r JOIN tasks t ON t.id=r.task_id
 LEFT JOIN projects p ON p.id=t.project_id
 JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
 JOIN workspaces w ON w.id=a.workspace_id
 JOIN identities actor ON actor.id=?
 WHERE r.triage_state='unprocessed'
   AND ((t.project_id IS NULL AND t.area_id IS NOT NULL)
      OR (t.project_id IS NOT NULL AND t.area_id IS NULL AND p.id IS NOT NULL))
   AND a.kind='private' AND w.kind='personal'
   AND a.owner_user_id=actor.id AND w.owner_user_id=actor.id
`;
/** Count and rows share exactly the same authorization and membership predicate.
 * Triage ignores completion. Physical task deletion removes its triage record.
 * Fail closed if the underlying v27 schema or actor is unavailable. */
export function readTargetInboxPage(
  db:DatabaseSync,actorUserId:string,limit=30,afterTaskId:string|null=null,
):TargetInboxPage|null{
  if(typeof actorUserId!=="string"||!/^[A-Za-z0-9_.:@-]{1,120}$/.test(actorUserId)||
    !Number.isSafeInteger(limit)||limit<1||limit>100||
    (afterTaskId!==null&&(typeof afterTaskId!=="string"||
      afterTaskId.length<1||afterTaskId.length>512||afterTaskId.trim()!==afterTaskId)))
    return null;
  try{
    if((db.prepare("SELECT value FROM metadata WHERE key='schema_version'")
      .get() as {value:string}|undefined)?.value!=="27")return null;
    const count=(db.prepare("SELECT COUNT(*) AS n"+AUTH_FROM)
      .get(actorUserId) as {n:number}).n;
    if(!Number.isSafeInteger(count)||count<0)return null;
    const sql=`SELECT t.id,t.title,t.project_id AS projectId,a.id AS areaId,
      t.status AS completion,t.revision AS taskRevision,
      r.triage_revision AS triageRevision`+AUTH_FROM+
      " AND (? IS NULL OR t.id > ? COLLATE BINARY) ORDER BY t.id COLLATE BINARY LIMIT ?";
    const rows=db.prepare(sql).all(actorUserId,afterTaskId,afterTaskId,limit+1) as TargetInboxTask[];
    const hasMore=rows.length>limit;
    const tasks=rows.slice(0,limit).map(row=>({
      id:row.id,title:row.title,projectId:row.projectId,areaId:row.areaId,
      completion:row.completion,taskRevision:row.taskRevision,
      triageRevision:row.triageRevision,
    }));
    return {tasks,count,hasMore,afterTaskId:hasMore?tasks.at(-1)!.id:null};
  }catch{
    return null;
  }
}
