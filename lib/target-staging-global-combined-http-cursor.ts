/**
 * R2d.3m.8: HMAC-signed, actor/session/scope/limit/restore-bound opaque
 * continuation for ONE combined Vše page. A cursor is NOT authentication.
 * Always re-admit the actual cookie/session and live-check all Area epochs.
 */
import {createHmac,timingSafeEqual} from "node:crypto";
import type {GlobalCombinedPositions} from "./target-global-combined-read-model";
import type {TargetGlobalTaskScope} from "./target-global-task-read-model";

const DOMAIN="lumi:r2d:global-combined-http-cursor:v1\0";
const PATTERN=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HEX=/^[a-f0-9]{64}$/;
const BINDING=/^[A-Za-z0-9_-]{43}$/;
const MAX_BYTES=4096;
const MAX_AGE_SECONDS=15*60;
const MAX_OFFSET=1_000_000;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
export type CombinedCursorContext={
  actorUserId:string;authenticationBinding:string;
  stagingDirectory:string;restoreGeneration:string;sessionSecret:string;
  scope:TargetGlobalTaskScope;limit:number;
};
type Claims={
  v:1;scope:TargetGlobalTaskScope;limit:number;binding:string;
  rev:string;positions:GlobalCombinedPositions;iat:number;exp:number;
};
export type VerifiedCombinedCursor=
  |{ok:true;positions:GlobalCombinedPositions;revision:string;expiresAt:number}
  |{ok:false;reason:"invalid"|"expired"};
const validPosition=(n:unknown)=>typeof n==="number"&&
  Number.isSafeInteger(n)&&n>=0&&n<=MAX_OFFSET;
export function validCombinedPositions(value:unknown):value is GlobalCombinedPositions{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const p=value as Record<string,unknown>;
  return Object.keys(p).sort().join(",")==="notes,projects,tasks"&&
    validPosition(p.projects)&&validPosition(p.tasks)&&validPosition(p.notes);
}
function safe(context:CombinedCursorContext){
  return !!context&&ACTOR.test(context.actorUserId)&&
    typeof context.stagingDirectory==="string"&&
    context.stagingDirectory.length>0&&
    typeof context.restoreGeneration==="string"&&
    context.restoreGeneration.length>0&&
    BINDING.test(context.authenticationBinding)&&
    typeof context.sessionSecret==="string"&&context.sessionSecret.length>=32&&
    ["all","personal","shared"].includes(context.scope)&&
    Number.isSafeInteger(context.limit)&&context.limit>=1&&context.limit<=100;
}
function key(secret:string){
  return createHmac("sha256",secret).update(DOMAIN+"key").digest();
}
function bound(context:CombinedCursorContext){
  return createHmac("sha256",key(context.sessionSecret))
    .update(DOMAIN+"binding\0"+JSON.stringify([
      context.actorUserId,context.authenticationBinding,
      context.stagingDirectory,context.restoreGeneration,
      context.scope,context.limit,
    ])).digest("hex");
}
function signature(payload:string,secret:string){
  return createHmac("sha256",key(secret))
    .update(DOMAIN+"signature\0"+payload).digest();
}
export function signGlobalCombinedCursor(
  context:CombinedCursorContext,revision:string,
  positions:GlobalCombinedPositions,expiresAt?:number,
  now=Math.floor(Date.now()/1000),
):string|null{
  if(!safe(context)||!HEX.test(revision)||!validCombinedPositions(positions)||
    !(positions.projects>0||positions.tasks>0||positions.notes>0)||
    !Number.isSafeInteger(now))return null;
  const exp=expiresAt??now+MAX_AGE_SECONDS;
  if(!Number.isSafeInteger(exp)||exp<=now||exp>now+MAX_AGE_SECONDS)return null;
  const claims:Claims={v:1,scope:context.scope,limit:context.limit,
    binding:bound(context),rev:revision,
    positions:{projects:positions.projects,tasks:positions.tasks,notes:positions.notes},
    iat:now,exp};
  const payload=Buffer.from(JSON.stringify(claims),"utf8").toString("base64url");
  const token=payload+"."+signature(payload,context.sessionSecret).toString("base64url");
  return token.length<=MAX_BYTES?token:null;
}
export function verifyGlobalCombinedCursor(
  context:CombinedCursorContext,cursor:string,
  now=Math.floor(Date.now()/1000),
):VerifiedCombinedCursor{
  const invalid=():VerifiedCombinedCursor=>({ok:false,reason:"invalid"});
  if(!safe(context)||typeof cursor!=="string"||cursor.length>MAX_BYTES||
    !PATTERN.test(cursor)||!Number.isSafeInteger(now))return invalid();
  try{
    const [encoded,sig]=cursor.split(".");
    const data=Buffer.from(encoded,"base64url");
    const actual=Buffer.from(sig,"base64url");
    if(data.toString("base64url")!==encoded||actual.toString("base64url")!==sig)
      return invalid();
    const expected=signature(encoded,context.sessionSecret);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))
      return invalid();
    const claims:unknown=JSON.parse(data.toString("utf8"));
    if(!claims||typeof claims!=="object"||Array.isArray(claims))return invalid();
    const p=claims as Record<string,unknown>;
    if(Object.keys(p).sort().join(",")!==
      "binding,exp,iat,limit,positions,rev,scope,v"||
      p.v!==1||p.scope!==context.scope||p.limit!==context.limit||
      p.binding!==bound(context)||typeof p.rev!=="string"||!HEX.test(p.rev)||
      !validCombinedPositions(p.positions)||
      !(p.positions.projects>0||p.positions.tasks>0||p.positions.notes>0)||
      !Number.isSafeInteger(p.iat)||!Number.isSafeInteger(p.exp)||
      (p.iat as number)>now||(p.exp as number)<=(p.iat as number)||
      (p.exp as number)-(p.iat as number)>MAX_AGE_SECONDS)
      return invalid();
    if((p.exp as number)<=now)return {ok:false,reason:"expired"};
    return {ok:true,positions:p.positions,revision:p.rev,
      expiresAt:p.exp as number};
  }catch{return invalid();}
}
