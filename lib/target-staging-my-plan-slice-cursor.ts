/**
 * R3-slice/BE-01: an opaque continuation for TWO actor-private My Plan day
 * buckets. A cursor is never an authentication or an authorization capability.
 * Its positions and revision must be checked against the live staging store.
 */
import {createHmac,timingSafeEqual} from "node:crypto";

const DOMAIN="lumi:r3:my-plan-two-day-http-cursor:v1\0";
const TOKEN=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HEX=/^[a-f0-9]{64}$/;
const BINDING=/^[A-Za-z0-9_-]{43}$/;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const MAX_OFFSET=1_000_000;
const MAX_LENGTH=4096;
const TTL=15*60;
export type MyPlanSlicePositions={today:number;tomorrow:number;undated:number};
export type MyPlanSliceCursorContext={
  actorUserId:string;authenticationBinding:string;stagingDirectory:string;
  restoreGeneration:string;sessionSecret:string;
  areaFilter:"all"|"personal"|"shared";evaluationDate:string;limit:number;
};
type Claims={
  v:1;scope:"my-plan-two-day";binding:string;rev:string;
  positions:MyPlanSlicePositions;iat:number;exp:number;
};
export type VerifiedMyPlanSliceCursor=
  |{ok:true;positions:MyPlanSlicePositions;revision:string;expiresAt:number}
  |{ok:false;reason:"invalid"|"expired"};

export function validMyPlanSlicePositions(value:unknown):value is MyPlanSlicePositions{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const p=value as Record<string,unknown>;
  return Object.keys(p).sort().join(",")==="today,tomorrow,undated"&&
    [p.today,p.tomorrow,p.undated].every(n=>typeof n==="number"&&
      Number.isSafeInteger(n)&&n>=0&&n<=MAX_OFFSET);
}
function safe(c:MyPlanSliceCursorContext):boolean{
  return !!c&&typeof c.actorUserId==="string"&&ACTOR.test(c.actorUserId)&&
    BINDING.test(c.authenticationBinding)&&
    typeof c.stagingDirectory==="string"&&c.stagingDirectory.length>0&&
    typeof c.restoreGeneration==="string"&&c.restoreGeneration.length>0&&
    typeof c.sessionSecret==="string"&&c.sessionSecret.length>=32&&
    ["all","personal","shared"].includes(c.areaFilter)&&
    /^\d{4}-\d{2}-\d{2}$/.test(c.evaluationDate)&&
    Number.isSafeInteger(c.limit)&&c.limit>=1&&c.limit<=100;
}
function key(secret:string){
  return createHmac("sha256",secret).update(DOMAIN+"key").digest();
}
function binding(c:MyPlanSliceCursorContext):string{
  return createHmac("sha256",key(c.sessionSecret))
    .update(DOMAIN+"binding\0"+JSON.stringify([
      c.actorUserId,c.authenticationBinding,c.stagingDirectory,
      c.restoreGeneration,c.areaFilter,c.evaluationDate,c.limit,
    ])).digest("hex");
}
function signature(encoded:string,secret:string){
  return createHmac("sha256",key(secret))
    .update(DOMAIN+"signature\0"+encoded).digest();
}
export function signMyPlanSliceCursor(
  c:MyPlanSliceCursorContext,revision:string,positions:MyPlanSlicePositions,
  expiresAt?:number,now=Math.floor(Date.now()/1000),
):string|null{
  if(!safe(c)||!HEX.test(revision)||!validMyPlanSlicePositions(positions)||
    positions.today+positions.tomorrow+positions.undated===0||!Number.isSafeInteger(now))return null;
  const exp=expiresAt??now+TTL;
  if(!Number.isSafeInteger(exp)||exp<=now||exp>now+TTL)return null;
  const claims:Claims={v:1,scope:"my-plan-two-day",binding:binding(c),
    rev:revision,positions:{today:positions.today,tomorrow:positions.tomorrow,
      undated:positions.undated},
    iat:now,exp};
  const payload=Buffer.from(JSON.stringify(claims),"utf8").toString("base64url");
  const signed=payload+"."+signature(payload,c.sessionSecret).toString("base64url");
  return signed.length<=MAX_LENGTH?signed:null;
}
export function verifyMyPlanSliceCursor(
  c:MyPlanSliceCursorContext,token:string,
  now=Math.floor(Date.now()/1000),
):VerifiedMyPlanSliceCursor{
  const invalid=():VerifiedMyPlanSliceCursor=>({ok:false,reason:"invalid"});
  if(!safe(c)||typeof token!=="string"||token.length>MAX_LENGTH||
    !TOKEN.test(token)||!Number.isSafeInteger(now))return invalid();
  try{
    const [encoded,mac]=token.split(".");
    const body=Buffer.from(encoded,"base64url");
    const actual=Buffer.from(mac,"base64url");
    if(body.toString("base64url")!==encoded||actual.toString("base64url")!==mac)
      return invalid();
    const expected=signature(encoded,c.sessionSecret);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))
      return invalid();
    const parsed:unknown=JSON.parse(body.toString("utf8"));
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return invalid();
    const p=parsed as Record<string,unknown>;
    if(Object.keys(p).sort().join(",")!=="binding,exp,iat,positions,rev,scope,v"||
      p.v!==1||p.scope!=="my-plan-two-day"||p.binding!==binding(c)||
      typeof p.rev!=="string"||!HEX.test(p.rev)||
      !validMyPlanSlicePositions(p.positions)||
      p.positions.today+p.positions.tomorrow+p.positions.undated===0||
      !Number.isSafeInteger(p.iat)||!Number.isSafeInteger(p.exp)||
      (p.iat as number)>now||(p.exp as number)<=(p.iat as number)||
      (p.exp as number)-(p.iat as number)>TTL)return invalid();
    if((p.exp as number)<=now)return {ok:false,reason:"expired"};
    return {ok:true,positions:p.positions,revision:p.rev,
      expiresAt:p.exp as number};
  }catch{return invalid();}
}
