/** R3-FE-4: content-free reload barrier for one unresolved note PATCH per tab.
 * The exact command stays in the target runtime. A browser reload destroys its
 * title/body/CAS payload, so only a random UUID and server-verified generation
 * survive in sessionStorage. No note ID, title, body, or authority token is saved.
 *
 * A missing/denied/corrupt storage API must fail CLOSED for new note writes.
 * Never treat "not_recorded" as evidence that a sent PATCH can no longer commit.
 */
const KEY="lumi-target-note-edit-unresolved-v2";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION=/^[A-Za-z0-9_-]{43}$/;
export type ReloadMarker={kind:"clear"}|{kind:"blocked";commandId:string}|
  {kind:"unavailable"};

function storage():Storage|null{
  try{return globalThis.sessionStorage??null;}catch{return null;}
}
function decode(raw:string):{generation:string;commandId:string}|null{
  try{
    const value:unknown=JSON.parse(raw);
    if(!value||typeof value!=="object"||Array.isArray(value))return null;
    const v=value as Record<string,unknown>;
    return Object.keys(v).sort().join(",")==="commandId,generation"&&
      typeof v.commandId==="string"&&UUID.test(v.commandId)&&
      typeof v.generation==="string"&&GENERATION.test(v.generation)
      ?{commandId:v.commandId,generation:v.generation}:null;
  }catch{return null;}
}
/** Call only with the current server-verified runtime generation, not an
 * unknown-local value. A new verified generation ends the old write context. */
export function noteEditReloadMarker(generation:string):ReloadMarker{
  if(!GENERATION.test(generation))return {kind:"unavailable"};
  try{
    const target=storage();
    if(!target)return {kind:"unavailable"};
    const raw=target.getItem(KEY);
    if(raw===null)return {kind:"clear"};
    const saved=decode(raw);
    if(!saved)return {kind:"unavailable"};
    if(saved.generation!==generation){
      target.removeItem(KEY);
      return target.getItem(KEY)===null?{kind:"clear"}:{kind:"unavailable"};
    }
    return {kind:"blocked",commandId:saved.commandId};
  }catch{return {kind:"unavailable"};}
}
/** Persist before scheduling PATCH; only the same command UUID can reuse a
 * reserved barrier. Never replace an unresolved UUID with a fresh command. */
export function reserveNoteEditReload(generation:string,commandId:string):boolean{
  if(!UUID.test(commandId)||!GENERATION.test(generation))return false;
  const state=noteEditReloadMarker(generation);
  if(state.kind==="blocked")return state.commandId===commandId;
  if(state.kind!=="clear")return false;
  try{
    const target=storage();if(!target)return false;
    target.setItem(KEY,JSON.stringify({generation,commandId}));
    const verified=noteEditReloadMarker(generation);
    return verified.kind==="blocked"&&verified.commandId===commandId;
  }catch{return false;}
}
/** Only an authorized, positively confirmed committed result may remove a
 * marker. An unconfirmed, denied or missing receipt retains the write barrier. */
export function confirmNoteEditReload(generation:string,commandId:string):boolean{
  if(!GENERATION.test(generation)||!UUID.test(commandId))return false;
  try{
    const target=storage();if(!target)return false;
    const raw=target.getItem(KEY);
    const saved=raw===null?null:decode(raw);
    if(!saved||saved.generation!==generation||saved.commandId!==commandId)return false;
    target.removeItem(KEY);
    return target.getItem(KEY)===null;
  }catch{return false;}
}
