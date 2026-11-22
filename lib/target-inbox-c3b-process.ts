/** C-3b short-lived isolated child protocol, deny by default. */
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import {parseStagingTargetInboxPage} from "./target-staging-read-process";
import {runStagingWriteChild} from "./target-staging-title-http-process";
import type {TargetReadLinearization} from "./target-task-read-model";
import type {HomeSummaryAreaEpoch} from "./target-my-plan-home-summary";
import type {InboxAcceptCommand,InboxAcceptUndoCommand,InboxAcceptResult}
  from "./target-inbox-accept-writer";
import type {InboxSuggestedChanges} from "./target-inbox-suggestions";
import type {InboxAcceptReceiptView} from "./target-inbox-accept-writer";

type Witness={linearization:TargetReadLinearization;areaEpochs:HomeSummaryAreaEpoch[]};
export type C3bPreview=Witness&{
  taskId:string;token:string;why:string;changes:InboxSuggestedChanges;
  source:"rule"|"ai";restoreGeneration:string;
  privateEpoch:number;notificationEpoch:number;consentEpoch:number;
};
export type C3bReceipt=Witness&InboxAcceptReceiptView;
export type C3bConsentRead={enabled:boolean;pending:boolean;epoch:number;
  restoreGeneration:string};
export type C3bConsentWrite={enabled:boolean;pending:boolean};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK=/^[^\u0000-\u001f\u007f]{1,512}$/u;
const primitive=(o:unknown):o is Record<string,unknown>=>
  Boolean(o)&&typeof o==="object"&&!Array.isArray(o);
const witness=(o:Record<string,unknown>):Witness|null=>{
  const page=parseStagingTargetInboxPage({
    ok:true,count:0,items:[],nextCursor:null,
    areaEpochs:o.areaEpochs,linearization:o.linearization,
  },1);
  return page?{linearization:page.linearization,areaEpochs:page.areaEpochs}:null;
};
const changesValid=(x:unknown):x is InboxSuggestedChanges=>{
  if(!primitive(x)||Object.keys(x).sort().join(",")!==
    "effectiveAreaId,projectId,taskAreaId,whenOn")return false;
  const id=(v:unknown)=>typeof v==="string"&&
    /^[A-Za-z0-9_.:@-]{1,120}$/.test(v);
  return (x.whenOn==="unchanged"||typeof x.whenOn==="string"&&
      /^\d{4}-\d{2}-\d{2}$/.test(x.whenOn))&&
    (x.projectId==="unchanged"||id(x.projectId))&&
    (x.taskAreaId===null||x.taskAreaId==="unchanged"||id(x.taskAreaId))&&
    (x.effectiveAreaId==="unchanged"||id(x.effectiveAreaId));
};
function parsePreview(value:unknown):C3bPreview|null{
  if(!primitive(value)||Object.keys(value).sort().join(",")!==
    "areaEpochs,changes,linearization,notificationEpoch,ok,privateEpoch,restoreGeneration,source,taskId,token,why"||
    value.ok!==true||typeof value.taskId!=="string"||!TASK.test(value.taskId)||
    typeof value.token!=="string"||!/^c3b1\.[A-Za-z0-9_-]{48,8192}$/.test(value.token)||
    typeof value.why!=="string"||value.why.length>512||!value.why.trim()||
    (value.source!=="rule"&&value.source!=="ai")||
    typeof value.restoreGeneration!=="string"||!UUID.test(value.restoreGeneration)||
    !changesValid(value.changes)||
    !Number.isSafeInteger(value.privateEpoch)||!Number.isSafeInteger(value.notificationEpoch)||
    (value.privateEpoch as number)<0||(value.notificationEpoch as number)<0)return null;
  const w=witness(value);
  return w?{...w,taskId:value.taskId,token:value.token,
    why:value.why,changes:value.changes,source:value.source,
    restoreGeneration:value.restoreGeneration,
    privateEpoch:value.privateEpoch as number,
    notificationEpoch:value.notificationEpoch as number}:null;
}
function parseWrite(value:unknown):InboxAcceptResult|null{
  if(!primitive(value))return null;
  const keys=Object.keys(value).sort().join(",");
  if(value.ok===true&&keys==="ok")return {ok:true};
  if(value.ok===true&&keys==="ok,replayed"&&value.replayed===true)
    return {ok:true,replayed:true};
  const reasons=["invalid_request","unavailable","stale_revision",
    "session_revoked","resync_required","idempotency_conflict","write_failed"];
  if(value.ok===false&&keys==="ok,reason"&&reasons.includes(value.reason as string))
    return {ok:false,reason:value.reason as Extract<InboxAcceptResult,{ok:false}>["reason"]};
  return null;
}
function parseReceipt(value:unknown):C3bReceipt|null{
  if(!primitive(value)||value.ok!==true||
    Object.keys(value).sort().join(",")!==
      "areaEpochs,linearization,next,ok,status"||
    !["committed","undone","not_recorded","conflict"].includes(value.status as string))
    return null;
  const w=witness(value);
  if(!w)return null;
  const n=value.next;
  if(n!==null&&(!primitive(n)||Object.keys(n).sort().join(",")!==
    "expectedPlanRevision,expectedPrivateEpoch,expectedTaskRevision,expectedTriageRevision"||
    !Number.isSafeInteger(n.expectedTaskRevision)||
    !Number.isSafeInteger(n.expectedTriageRevision)||
    !Number.isSafeInteger(n.expectedPrivateEpoch)||
    (n.expectedPlanRevision!==null&&!Number.isSafeInteger(n.expectedPlanRevision))))
    return null;
  return {...w,status:value.status as C3bReceipt["status"],
    next:n as C3bReceipt["next"]};
}
function parseConsent(value:unknown,read:boolean):C3bConsentRead|C3bConsentWrite|null{
  if(!primitive(value)||value.ok!==true||typeof value.enabled!=="boolean"||
     typeof value.pending!=="boolean"||
     Object.keys(value).sort().join(",")!==(read?
       "enabled,epoch,ok,pending,restoreGeneration":"enabled,ok,pending"))
    return null;
  if(!read)return {enabled:value.enabled,pending:value.pending};
  return Number.isSafeInteger(value.epoch)&&(value.epoch as number)>=0&&
    typeof value.restoreGeneration==="string"&&UUID.test(value.restoreGeneration)
    ?{enabled:value.enabled,pending:value.pending,
      epoch:value.epoch as number,restoreGeneration:value.restoreGeneration}:null;
}
const call=async(config:StagingPersonalReadConfig,body:object)=>
  runStagingWriteChild(config,"target-staging-inbox-c3b-child.mjs",JSON.stringify(body),512*1024);
export const previewC3bInChild=async(config:StagingPersonalReadConfig,taskId:string)=>
  parsePreview(await call(config,{operation:"preview",taskId}));
export const acceptC3bInChild=async(config:StagingPersonalReadConfig,command:InboxAcceptCommand)=>
  parseWrite(await call(config,{operation:"accept",command}));
export const undoC3bInChild=async(config:StagingPersonalReadConfig,command:InboxAcceptUndoCommand)=>
  parseWrite(await call(config,{operation:"undo",command}));
export const receiptC3bInChild=async(config:StagingPersonalReadConfig,command:InboxAcceptCommand)=>
  parseReceipt(await call(config,{operation:"receipt",command}));
export const readC3bConsentInChild=async(config:StagingPersonalReadConfig)=>
  parseConsent(await call(config,{operation:"consent_read"}),true) as C3bConsentRead|null;
export const writeC3bConsentInChild=async(
  config:StagingPersonalReadConfig,mode:"grant"|"revoke",
)=>
  parseConsent(await call(config,{operation:"consent_write",mode}),false) as C3bConsentWrite|null;
