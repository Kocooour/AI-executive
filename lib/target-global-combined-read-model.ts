/**
 * R2d.3m.7 — one pinned, actor-authorized combined Vše page.
 *
 * Internal staging-only reader. No HTTP, cursor capability or production UI.
 * Consumers MUST recheck both full Area epochs and noteAreaEpochs in the
 * same live session/ACL transaction before releasing any title.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {
  readAuthorizedGlobalTaskPage,
  type TargetGlobalTask,type TargetGlobalTaskScope,
} from "./target-global-task-read-model";
import {
  readAuthorizedGlobalProjectPage,type TargetGlobalProject,
} from "./target-global-project-read-model";
import {
  readAuthorizedGlobalNotePage,
  type TargetGlobalNote,type GlobalNoteAreaEpoch,
} from "./target-global-note-read-model";
import type {HomeSummaryAreaEpoch} from "./target-my-plan-home-summary";
import type {TargetReadLinearization} from "./target-task-read-model";

export type GlobalCombinedKind="project"|"task"|"note";
export type GlobalCombinedPositions={projects:number;tasks:number;notes:number};
export type GlobalCombinedItem=
  |{kind:"project";item:TargetGlobalProject}
  |{kind:"task";item:TargetGlobalTask}
  |{kind:"note";item:TargetGlobalNote};
export type TargetGlobalCombinedPage={
  scope:TargetGlobalTaskScope;
  items:GlobalCombinedItem[];
  hasMore:boolean;
  /** Opaque continuation positions: server only until HMAC HTTP adapter exists. */
  nextPositions:GlobalCombinedPositions|null;
  revision:string;
  /** All server-only witnesses, including empty readable Areas. */
  linearization:TargetReadLinearization;
  areaEpochs:HomeSummaryAreaEpoch[];
  noteAreaEpochs:GlobalNoteAreaEpoch[];
};

const actorPattern=/^[A-Za-z0-9_.:@-]{1,120}$/;
const generationPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OFFSET=1_000_000;
export const INITIAL_GLOBAL_COMBINED_POSITIONS:Readonly<GlobalCombinedPositions>=
  Object.freeze({projects:0,tasks:0,notes:0});
const validOffset=(x:unknown):x is number=>
  typeof x==="number"&&Number.isSafeInteger(x)&&x>=0&&x<=MAX_OFFSET;
const itemOrder:Record<GlobalCombinedKind,number>=
  {project:0,task:1,note:2};
/** BINARY ID order with a deterministic kind tie-break; never JS localeCompare. */
function compare(a:GlobalCombinedItem,b:GlobalCombinedItem):number{
  return Buffer.compare(Buffer.from(a.item.id),Buffer.from(b.item.id))||
    itemOrder[a.kind]-itemOrder[b.kind];
}

/**
 * Every child selector applies actor membership inside SQLite BEFORE its
 * per-kind LIMIT/OFFSET. This combines up to 3*limit bounded rows, not full
 * table scans, and does not concatenate independently committed snapshots.
 *
 * Must run in the caller's SAME pinned SQLite snapshot as canonical preflight
 * and the signed actor verification. The raw request is not an auth boundary.
 */
export function readAuthorizedGlobalCombinedPage(
  db:DatabaseSync,request:{
    actorUserId:string;scope:TargetGlobalTaskScope;
    limit:number;positions:GlobalCombinedPositions;restoreGeneration:string;
  },
):TargetGlobalCombinedPage|null{
  if(!request||typeof request.actorUserId!=="string"||
    !actorPattern.test(request.actorUserId)||
    !["all","personal","shared"].includes(request.scope)||
    !Number.isSafeInteger(request.limit)||request.limit<1||request.limit>100||
    typeof request.restoreGeneration!=="string"||
    !generationPattern.test(request.restoreGeneration)||
    !request.positions||typeof request.positions!=="object"||
    Array.isArray(request.positions)||
    Object.keys(request.positions).sort().join(",")!=="notes,projects,tasks"||
    !validOffset(request.positions.projects)||
    !validOffset(request.positions.tasks)||
    !validOffset(request.positions.notes))return null;
  try{
    const common={actorUserId:request.actorUserId,scope:request.scope,
      restoreGeneration:request.restoreGeneration,limit:request.limit};
    // All three reads MUST share the single DB read transaction owned by the
    // preflight facade; detached child processes are NOT used for aggregation.
    const projects=readAuthorizedGlobalProjectPage(db,{
      ...common,offset:request.positions.projects,
    });
    const tasks=readAuthorizedGlobalTaskPage(db,{
      ...common,offset:request.positions.tasks,
    });
    const notes=readAuthorizedGlobalNotePage(db,{
      ...common,offset:request.positions.notes,
    });
    if(!projects||!tasks||!notes)return null;
    const witness=JSON.stringify(projects.areaEpochs);
    const linear=JSON.stringify(projects.linearization);
    if(JSON.stringify(tasks.areaEpochs)!==witness||
      JSON.stringify(notes.areaEpochs)!==witness||
      JSON.stringify(tasks.linearization)!==linear||
      JSON.stringify(notes.linearization)!==linear||
      projects.scope!==request.scope||tasks.scope!==request.scope||
      notes.scope!==request.scope||
      notes.noteAreaEpochs.length!==projects.areaEpochs.length||
      notes.noteAreaEpochs.some((a,i)=>a.areaId!==projects.areaEpochs[i]?.areaId))
      return null;
    const candidates:GlobalCombinedItem[]=[
      ...projects.projects.map(item=>({kind:"project" as const,item})),
      ...tasks.tasks.map(item=>({kind:"task" as const,item})),
      ...notes.notes.map(item=>({kind:"note" as const,item})),
    ].sort(compare);
    const items=candidates.slice(0,request.limit);
    const positions={...request.positions};
    for(const item of items){
      if(item.kind==="project")positions.projects++;
      else if(item.kind==="task")positions.tasks++;
      else positions.notes++;
    }
    const hasMore=candidates.length>request.limit||
      projects.hasMore||tasks.hasMore||notes.hasMore;
    // Never create a continuation the next reader would reject. Conservative
    // bounded offset exhaustion is an unavailable page, not partial content.
    if(hasMore&&(!validOffset(positions.projects)||
      !validOffset(positions.tasks)||!validOffset(positions.notes)))return null;
    const digest=createHash("sha256")
      .update("lumi:r2d:combined-global-index:v1\0")
      .update(JSON.stringify([
        request.actorUserId,request.scope,request.restoreGeneration,
        projects.revision,tasks.revision,notes.revision,
      ])).digest("hex");
    return {
      scope:request.scope,items,hasMore,
      nextPositions:hasMore?positions:null,revision:digest,
      linearization:projects.linearization,
      areaEpochs:projects.areaEpochs,
      noteAreaEpochs:notes.noteAreaEpochs,
    };
  }catch{return null;}
}
