/** Tab-scoped, content-free ambiguity barrier for private note CREATE.
 * An unresolved dispatched command never gets a replacement UUID after reload.
 * Only a positive server receipt or verified 201/200 clears it.
 * Draft/title/body/noteId/Area ID/credentials must NEVER enter storage. */
const KEY="lumi-private-note-create-unresolved-v1";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION=/^[A-Za-z0-9_-]{43}$/;
export type CreateMarker={kind:"clear"}|{kind:"blocked";commandId:string}|{kind:"unavailable"};
function storage():Storage|null{try{return globalThis.sessionStorage??null;}catch{return null;}}
function decode(raw:string):{generation:string;commandId:string}|null{
  try{
    const v:unknown=JSON.parse(raw);
    if(!v||typeof v!=="object"||Array.isArray(v))return null;
    const obj=v as Record<string,unknown>;
    return Object.keys(obj).sort().join(",")==="commandId,generation"&&
      typeof obj.commandId==="string"&&UUID.test(obj.commandId)&&
      typeof obj.generation==="string"&&GENERATION.test(obj.generation)
      ?{commandId:obj.commandId,generation:obj.generation}:null;
  }catch{return null;}
}
export function privateNoteCreateMarker(generation:string):CreateMarker{
  if(!GENERATION.test(generation))return {kind:"unavailable"};
  try{
    const store=storage();if(!store)return {kind:"unavailable"};
    const raw=store.getItem(KEY);if(raw===null)return {kind:"clear"};
    const marker=decode(raw);if(!marker)return {kind:"unavailable"};
    if(marker.generation!==generation){
      store.removeItem(KEY);
      return store.getItem(KEY)===null?{kind:"clear"}:{kind:"unavailable"};
    }
    return {kind:"blocked",commandId:marker.commandId};
  }catch{return {kind:"unavailable"};}
}
export function reservePrivateNoteCreate(generation:string,commandId:string):boolean{
  if(!GENERATION.test(generation)||!UUID.test(commandId))return false;
  const current=privateNoteCreateMarker(generation);
  if(current.kind==="blocked")return current.commandId===commandId;
  if(current.kind!=="clear")return false;
  try{
    const store=storage();if(!store)return false;
    store.setItem(KEY,JSON.stringify({generation,commandId}));
    const checked=privateNoteCreateMarker(generation);
    return checked.kind==="blocked"&&checked.commandId===commandId;
  }catch{return false;}
}
export function confirmPrivateNoteCreate(generation:string,commandId:string):boolean{
  if(!GENERATION.test(generation)||!UUID.test(commandId))return false;
  try{
    const store=storage();if(!store)return false;
    const saved=store.getItem(KEY);
    const parsed=saved===null?null:decode(saved);
    if(!parsed||parsed.generation!==generation||parsed.commandId!==commandId)
      return false;
    store.removeItem(KEY);
    return store.getItem(KEY)===null;
  }catch{return false;}
}
