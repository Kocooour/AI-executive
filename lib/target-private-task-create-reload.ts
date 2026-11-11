/** Tab-only content-free barrier. Never persist title, Area, task ID, or tokens.
 * After a full reload only the command UUID remains: exact-command recovery
 * cannot run without the original private title, so writes stay locked. */
const KEY="lumi-private-task-create-unresolved-v1";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION=/^[A-Za-z0-9_-]{43}$/;
export type TaskCreateMarker={kind:"clear"}|{kind:"blocked";commandId:string}|{kind:"unavailable"};
function storage():Storage|null{
  try{return globalThis.sessionStorage??null;}catch{return null;}
}
function decode(raw:string):{generation:string;commandId:string}|null{
  try{
    const v:unknown=JSON.parse(raw);
    if(!v||typeof v!=="object"||Array.isArray(v))return null;
    const x=v as Record<string,unknown>;
    return Object.keys(x).sort().join(",")==="commandId,generation"&&
      typeof x.commandId==="string"&&UUID.test(x.commandId)&&
      typeof x.generation==="string"&&GENERATION.test(x.generation)
      ?{generation:x.generation,commandId:x.commandId}:null;
  }catch{return null;}
}
export function privateTaskCreateMarker(generation:string):TaskCreateMarker{
  if(!GENERATION.test(generation))return {kind:"unavailable"};
  try{
    const store=storage();if(!store)return {kind:"unavailable"};
    const raw=store.getItem(KEY);if(raw===null)return {kind:"clear"};
    const value=decode(raw);
    return value?{kind:"blocked",commandId:value.commandId}:{kind:"unavailable"};
  }catch{return {kind:"unavailable"};}
}
export function reservePrivateTaskCreate(generation:string,commandId:string):boolean{
  if(!GENERATION.test(generation)||!UUID.test(commandId))return false;
  if(privateTaskCreateMarker(generation).kind!=="clear")return false;
  try{
    const store=storage();if(!store)return false;
    store.setItem(KEY,JSON.stringify({generation,commandId}));
    const result=privateTaskCreateMarker(generation);
    return result.kind==="blocked"&&result.commandId===commandId;
  }catch{return false;}
}
export function confirmPrivateTaskCreate(generation:string,commandId:string):boolean{
  if(!GENERATION.test(generation)||!UUID.test(commandId))return false;
  try{
    const store=storage();if(!store)return false;
    const raw=store.getItem(KEY),value=raw===null?null:decode(raw);
    if(value?.generation!==generation||value.commandId!==commandId)return false;
    store.removeItem(KEY);
    return store.getItem(KEY)===null;
  }catch{return false;}
}
