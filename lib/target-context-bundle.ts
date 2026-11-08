/**
 * R2d.4i/4j — authorized target Context Resolver bundle for AI (staging, internal).
 *
 * Minimum context for a FUTURE provider call: titles, plus (R2d.4j, owner
 * decision 2026-11-08) a capped body excerpt of `find` note items. This module makes no
 * provider/network call, adds no HTTP route, UI or schema. Every source row is
 * produced by an already actor-bound selector inside ONE pinned read snapshot,
 * so the bundle is never wider than the actor's own authorized reads, and
 * nothing is serialized before authorization. A note body comes ONLY from
 * readAuthorizedTargetNote (same snapshot); any disagreement fails closed.
 *
 * Purposes and scopes (any other combination is rejected with null):
 *  - what_matters / plan_today: scope my-plan | personal | shared (the My Plan
 *    population; "personal"/"shared" narrow it). "all" is rejected because the
 *    Attention / My Plan population is never the global Vše index.
 *  - find: scope all | personal | shared over the global authorized title
 *    search ("my-plan" is rejected).
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {attentionEvaluationWindow,readAuthorizedAttentionCandidatePage}
  from "./target-attention-read-model";
import type {AttentionAreaFilter,AttentionCandidate} from "./target-attention-read-model";
import {readAuthorizedMyPlanDayTaskPage} from "./target-my-plan-day-task-read-model";
import type {MyPlanDayTask,MyPlanDayTaskPage} from "./target-my-plan-day-task-read-model";
import {readAuthorizedTitleSearchPage,validAuthorizedTitleQuery}
  from "./target-authorized-title-search";
import type {TargetReadLinearization} from "./target-task-read-model";
import type {HomeSummaryAreaEpoch} from "./target-my-plan-home-summary";
import type {GlobalNoteAreaEpoch} from "./target-global-note-read-model";
import {readPreflightedStoreSnapshot} from "./target-task-staging-reader";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {verifiedActor} from "./target-task-authenticated-read";
import type {TargetStagingReadCredential} from "./target-task-authenticated-read";
import {readAuthorizedTargetNote} from "./target-note-access";
import {temporalCalendarOrdinal} from "./target-task-temporal-read-model";

export type ContextBundlePurpose="what_matters"|"plan_today"|"find";
export type ContextBundleScope="my-plan"|"all"|"personal"|"shared";
export type ContextBundleRequest={
  purpose:ContextBundlePurpose;scope:ContextBundleScope;query:string|null;
  nowMs:number;timeZone:string;maxItems:number;
};
export type ContextBundleSource="attention"|"my_plan"|"global_index"|"title_search";
export type ContextBundleItem={
  kind:"task"|"project"|"note";id:string;title:string;areaKind:"private"|"shared";
  assignedToMe?:true;dueOn?:string|null;whenOn?:string|null;
  attention?:{ruleId:string;severity:number;relevantOn:string;lifecycle:"active"};
  /** Notes only (find): authorized body, capped; `bodyTruncated` only when cut. */
  body?:string;bodyTruncated?:true;
  provenance:{source:ContextBundleSource;revision:number|null};
};
export type ContextBundleWitness={
  linearization:TargetReadLinearization;areaEpochs:HomeSummaryAreaEpoch[];
  noteAreaEpochs:GlobalNoteAreaEpoch[];
  privateEpoch:number|null;attentionEpoch:number|null;
  /** Authorized note guard data of the emitted notes (future live guard). */
  noteGuards:{noteId:string;noteRevision:number;parentRevision:number|null}[];
  sourceRevisions:{attention:string|null;myPlanToday:string|null;
    myPlanUpcoming:string|null;titleSearch:string|null};
};
/** `witness` is INTERNAL ONLY (future live release guard); never send it out. */
export type TargetContextBundle={
  bundleVersion:1;purpose:ContextBundlePurpose;scope:ContextBundleScope;
  generatedAtMs:number;timeZone:string;evaluationDate:string;
  items:ContextBundleItem[];truncated:boolean;revision:string;
  witness:ContextBundleWitness;
};

/** Cap of the serialized provider payload (public part only). */
export const MAX_CONTEXT_BUNDLE_BYTES=32*1024;
/** Per-note body excerpt cap in UTF-8 bytes (cut on a code-point boundary). */
export const MAX_CONTEXT_NOTE_BODY_BYTES=4096;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURPOSES=["what_matters","plan_today","find"];
const REQUEST_KEYS="maxItems,nowMs,purpose,query,scope,timeZone";
const SOURCE_LIMIT=100;
const ZERO_REVISION="0".repeat(64);

const plain=(x:unknown):x is Record<string,unknown>=>{
  if(!x||typeof x!=="object"||Array.isArray(x))return false;
  const proto=Object.getPrototypeOf(x);
  return proto===Object.prototype||proto===null;
};
const addDays=(date:string,n:number)=>
  new Date(Date.parse(date+"T00:00:00Z")+n*86_400_000).toISOString().slice(0,10);

/** Strict request validation shared by every layer. Returns the evaluation
 * date or null. Purpose/scope combinations are part of the contract. */
function validRequest(r:unknown):string|null {
  if(!plain(r)||Object.keys(r).sort().join(",")!==REQUEST_KEYS)return null;
  const q=r as unknown as ContextBundleRequest;
  if(!PURPOSES.includes(q.purpose))return null;
  if(q.purpose==="find"){
    if(!["all","personal","shared"].includes(q.scope)||
      !validAuthorizedTitleQuery(q.query))return null;
  }else if(!["my-plan","personal","shared"].includes(q.scope)||q.query!==null)
    return null;
  if(typeof q.maxItems!=="number"||!Number.isSafeInteger(q.maxItems)||
    q.maxItems<1||q.maxItems>50)return null;
  const w=attentionEvaluationWindow(q.nowMs,q.timeZone);
  return w?w.evaluationDate:null;
}

const sameJson=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const publicPart=(b:Omit<TargetContextBundle,"witness">)=>({
  bundleVersion:b.bundleVersion,purpose:b.purpose,scope:b.scope,
  generatedAtMs:b.generatedAtMs,timeZone:b.timeZone,evaluationDate:b.evaluationDate,
  items:b.items.map(i=>({
    kind:i.kind,id:i.id,title:i.title,areaKind:i.areaKind,
    ...(i.assignedToMe===true?{assignedToMe:true as const}:{}),
    ...(i.dueOn!==undefined?{dueOn:i.dueOn}:{}),
    ...(i.whenOn!==undefined?{whenOn:i.whenOn}:{}),
    ...(i.kind==="note"&&typeof i.body==="string"?{body:i.body,
      ...(i.bodyTruncated===true?{bodyTruncated:true as const}:{})}:{}),
    ...(i.attention?{attention:{ruleId:i.attention.ruleId,severity:i.attention.severity,
      relevantOn:i.attention.relevantOn,lifecycle:i.attention.lifecycle}}:{}),
    provenance:{source:i.provenance.source,revision:i.provenance.revision},
  })),
  truncated:b.truncated,revision:b.revision,
});

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes, cut only between
 * code points. */
export function truncateUtf8(text:string,maxBytes:number):{text:string;truncated:boolean}{
  // A non-integer or negative cap (NaN, Infinity, -1) is a caller bug: emit nothing.
  const cap=Number.isSafeInteger(maxBytes)&&maxBytes>=0?maxBytes:0;
  if(Buffer.byteLength(text,"utf8")<=cap)return {text,truncated:false};
  let used=0,end=0;
  for(const ch of text){
    const n=Buffer.byteLength(ch,"utf8");
    if(used+n>cap)break;
    used+=n;end+=ch.length;
  }
  return {text:text.slice(0,end),truncated:true};
}

/** The authorized read must describe exactly the note the search returned. */
export function authorizedNoteAgrees(
  row:{id:string;title:string;areaKind:string;projectId?:string|null},
  read:{note:{id:string;title:string;body:string;areaKind:string;projectId:string|null;revision:number}}|null,
):boolean {
  if(!read||typeof read.note.body!=="string")return false;
  const n=read.note;
  return n.id===row.id&&n.title===row.title&&n.areaKind===row.areaKind&&
    n.projectId===(row.projectId??null)&&Number.isSafeInteger(n.revision);
}

/** Public JSON for a provider: no witness or Area/other-user IDs; note bodies
 * only as the capped, already-authorized excerpt held by the item. Null if it cannot fit the byte cap. */
export function serializeTargetContextBundleForProvider(
  bundle:TargetContextBundle,
):string|null {
  try{
    const json=JSON.stringify(publicPart(bundle));
    return Buffer.byteLength(json,"utf8")<=MAX_CONTEXT_BUNDLE_BYTES?json:null;
  }catch{return null;}
}

type Draft=ContextBundleItem&{kind:"task"};
function taskItem(t:MyPlanDayTask):Draft {
  return {
    kind:"task",id:t.taskId,title:t.title,areaKind:t.areaKind,
    ...(t.areaKind==="shared"?{assignedToMe:true as const}:{}),
    dueOn:t.dueOn,whenOn:t.whenOn,
    provenance:{source:"my_plan",revision:null},
  };
}
function attentionOf(a:AttentionCandidate){
  return {ruleId:a.ruleId,severity:a.severity,relevantOn:a.relevantOn,
    lifecycle:"active" as const};
}
function attentionItem(a:AttentionCandidate):Draft {
  return {
    kind:"task",id:a.taskId,title:a.title,areaKind:a.areaKind,
    ...(a.areaKind==="shared"?{assignedToMe:true as const}:{}),
    dueOn:a.dueOn,whenOn:a.whenOn,attention:attentionOf(a),
    provenance:{source:"attention",revision:a.sourceRevision},
  };
}
/** Same task from two sources must agree on every shared field, else anomaly. */
function mergeTask(into:Draft,from:AttentionCandidate):boolean {
  if(into.attention||into.title!==from.title||into.areaKind!==from.areaKind||
    into.dueOn!==from.dueOn||into.whenOn!==from.whenOn||
    (into.assignedToMe===true)!==(from.assignedToMe===true))return false;
  into.attention=attentionOf(from);
  into.provenance={source:"attention",revision:from.sourceRevision};
  return true;
}

/**
 * Db-level resolver. MUST run inside the caller's pinned read snapshot with an
 * actor taken from a verified credential (never from client input).
 */
export function resolveAuthorizedTargetContextBundle(
  db:DatabaseSync,request:ContextBundleRequest&{actorUserId:string;restoreGeneration:string},
):TargetContextBundle|null {
  try{
    if(!plain(request)||typeof request.actorUserId!=="string"||
      !ACTOR.test(request.actorUserId)||typeof request.restoreGeneration!=="string"||
      !UUID.test(request.restoreGeneration))return null;
    const {actorUserId,restoreGeneration,...bare}=request;
    // A source returning an empty page for a non-existent identity would be
    // indistinguishable from "nothing authorized": fail closed instead.
    if(!db.prepare("SELECT 1 FROM identities WHERE id=?").get(actorUserId))return null;
    // Fail closed on corrupt actor-private plan rows: a malformed when_on would
    // otherwise match no date window and silently drop a task (partial bundle).
    const badPlans=db.prepare(`SELECT COUNT(*) AS n FROM personal_task_plans
      WHERE user_id=? AND (typeof(when_on)<>'text' OR length(when_on)<>10 OR
        date(when_on,'+0 days') IS NOT when_on)`).get(actorUserId) as {n:number}|undefined;
    if(!badPlans||badPlans.n!==0)return null;
    const evaluationDate=validRequest(bare);
    if(!evaluationDate)return null;
    const {purpose,scope,nowMs,timeZone,maxItems}=bare;
    let drafts:Draft[]|ContextBundleItem[]=[];
    let more=false;
    const noteGuards=new Map<string,ContextBundleWitness["noteGuards"][number]>();
    let witness:ContextBundleWitness;
    const srcRev={attention:null,myPlanToday:null,myPlanUpcoming:null,
      titleSearch:null} as ContextBundleWitness["sourceRevisions"];

    if(purpose==="find"){
      const sp=readAuthorizedTitleSearchPage(db,{
        actorUserId,scope:scope as "all"|"personal"|"shared",query:bare.query as string,
        limit:maxItems,offset:0,restoreGeneration,
      });
      if(!sp||sp.scope!==scope)return null;
      const seen=new Set<string>();
      const items:ContextBundleItem[]=[];
      for(const i of sp.items){
        const key=i.kind+"\0"+i.id;
        if(seen.has(key))continue;
        seen.add(key);
        if(i.kind==="note"){
          // Same pinned snapshot as the search; any disagreement => no bundle.
          const read=readAuthorizedTargetNote(db,{actorUserId,noteId:i.id});
          if(!authorizedNoteAgrees(i as {id:string;title:string;areaKind:string;
            projectId?:string|null},read))return null;
          const {note,guard}=read as NonNullable<typeof read>;
          const cut=truncateUtf8(note.body,MAX_CONTEXT_NOTE_BODY_BYTES);
          noteGuards.set(i.id,{noteId:guard.noteId,noteRevision:guard.noteRevision,
            parentRevision:guard.parentRevision});
          items.push({kind:"note",id:i.id,title:i.title,areaKind:i.areaKind,
            body:cut.text,...(cut.truncated?{bodyTruncated:true as const}:{}),
            provenance:{source:"title_search",revision:note.revision}});
        }else items.push({kind:i.kind,id:i.id,title:i.title,areaKind:i.areaKind,
          provenance:{source:"title_search",revision:null}});
      }
      drafts=items;more=sp.hasMore;srcRev.titleSearch=sp.revision;
      witness={linearization:sp.linearization,areaEpochs:sp.areaEpochs,
        noteAreaEpochs:sp.noteAreaEpochs,privateEpoch:null,attentionEpoch:null,
        noteGuards:[],sourceRevisions:srcRev};
    }else{
      const filter:AttentionAreaFilter=scope==="my-plan"?"all"
        :scope as "personal"|"shared";
      const att=readAuthorizedAttentionCandidatePage(db,{
        actorUserId,areaFilter:filter,view:"active",evaluatedAtMs:nowMs,timeZone,
        limit:SOURCE_LIMIT,offset:0,restoreGeneration,
      });
      if(!att||att.evaluationDate!==evaluationDate)return null;
      const day=(window:"today"|"upcoming",through:string|null)=>
        readAuthorizedMyPlanDayTaskPage(db,{
          actorUserId,areaFilter:filter,window,evaluationDate,throughDate:through,
          limit:SOURCE_LIMIT,offset:0,restoreGeneration,
        });
      const today=day("today",null);
      if(!today)return null;
      let upcoming:MyPlanDayTaskPage|null=null;
      if(purpose==="plan_today"){
        const next=addDays(evaluationDate,1);
        const a=temporalCalendarOrdinal(evaluationDate),b=temporalCalendarOrdinal(next);
        upcoming=day("upcoming",next);
        if(!upcoming||a===null||b===null||b-a!==1)return null;
      }
      for(const p of upcoming?[today,upcoming]:[today]){
        if(p.privateEpoch!==att.privateEpoch||
          !sameJson(p.linearization,att.linearization)||
          !sameJson(p.areaEpochs,att.areaEpochs))return null;
      }
      const attByTask=new Map<string,AttentionCandidate>();
      for(const a of att.items)attByTask.set(a.taskId,a);
      const out:Draft[]=[];
      const byId=new Map<string,Draft>();
      const push=(d:Draft)=>{if(!byId.has(d.id)){byId.set(d.id,d);out.push(d);}};
      if(purpose==="what_matters"){
        // Attention first (already severity/date/id ordered), then the rest
        // of today's plan; the same task is merged, never repeated.
        for(const a of att.items)push(attentionItem(a));
        for(const t of today.tasks){
          const have=byId.get(t.taskId);
          if(have){
            const same=have.title===t.title&&have.areaKind===t.areaKind&&
              have.dueOn===t.dueOn&&have.whenOn===t.whenOn;
            if(!same)return null;
          }else push(taskItem(t));
        }
        more=att.hasMore||today.hasMore;
      }else{
        for(const t of [...today.tasks,...(upcoming as MyPlanDayTaskPage).tasks]){
          if(byId.has(t.taskId))continue;
          const d=taskItem(t);
          const a=attByTask.get(t.taskId);
          if(a&&!mergeTask(d,a))return null;
          push(d);
        }
        // Attention beyond the first page could not be attached: say so.
        more=today.hasMore||(upcoming as MyPlanDayTaskPage).hasMore||att.hasMore;
      }
      drafts=out;
      srcRev.attention=att.revision;srcRev.myPlanToday=today.revision;
      srcRev.myPlanUpcoming=upcoming?upcoming.revision:null;
      witness={linearization:att.linearization,areaEpochs:att.areaEpochs,
        noteAreaEpochs:[],privateEpoch:att.privateEpoch,
        attentionEpoch:att.attentionEpoch,noteGuards:[],sourceRevisions:srcRev};
    }

    // An emitted item must carry a real title (CHECK bypass would yield blanks).
    if(drafts.some(d=>typeof d.title!=="string"||d.title.trim().length===0))return null;
    // Item cap, then byte cap by dropping the lowest-priority (last) items.
    let items=drafts.slice(0,maxItems) as ContextBundleItem[];
    let truncated=more||drafts.length>maxItems;
    const head={bundleVersion:1 as const,purpose,scope,generatedAtMs:nowMs,timeZone,
      evaluationDate};
    const size=()=>Buffer.byteLength(JSON.stringify(publicPart(
      {...head,items,truncated,revision:ZERO_REVISION})),"utf8");
    while(items.length>0&&size()>MAX_CONTEXT_BUNDLE_BYTES){
      items=items.slice(0,-1);truncated=true;
    }
    if(size()>MAX_CONTEXT_BUNDLE_BYTES)return null;
    witness.noteGuards=items.filter(i=>i.kind==="note")
      .map(i=>noteGuards.get(i.id) as ContextBundleWitness["noteGuards"][number]);
    const hash=createHash("sha256").update("lumi:r2d4:context-bundle:v1\0")
      .update(JSON.stringify([
        1,restoreGeneration,actorUserId,purpose,scope,bare.query,nowMs,timeZone,
        maxItems,evaluationDate,srcRev.attention,srcRev.myPlanToday,
        srcRev.myPlanUpcoming,srcRev.titleSearch,truncated,
        publicPart({...head,items,truncated,revision:ZERO_REVISION}).items,
      ])).digest("hex");
    return {...head,items,truncated,revision:hash,witness};
  }catch{return null;}
}

/** Credential-bound, preflighted, ONE pinned snapshot. Internal only. */
export function readPreflightedTargetContextBundle(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:ContextBundleRequest,
):TargetContextBundle|null {
  try{
    if(!validRequest(request))return null;
    return readPreflightedStoreSnapshot<TargetContextBundle>(store,db=>{
      const actorUserId=verifiedActor(db,access);
      return actorUserId?resolveAuthorizedTargetContextBundle(db,{
        purpose:request.purpose,scope:request.scope,query:request.query,
        nowMs:request.nowMs,timeZone:request.timeZone,maxItems:request.maxItems,
        actorUserId,restoreGeneration:store.expectedRestoreGeneration,
      }):null;
    });
  }catch{return null;}
}
