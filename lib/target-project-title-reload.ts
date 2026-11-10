/** Global per-tab content-free barrier for an unresolved project rename.
 * Unlike the note marker, a different auth generation NEVER removes it: an
 * old in-flight PATCH may still commit after a new login. Only a positively
 * verified receipt or an unambiguous FIRST-request rejection may clear it.
 * No project ID, title, Area, command payload or credential is persisted.
 */
const KEY="lumi-target-project-title-unresolved-v1";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING=/^[A-Za-z0-9_-]{43}$/;
export type ProjectTitleReloadMarker={kind:"clear"}|
  {kind:"blocked";commandId:string;principalBinding:string}|{kind:"unavailable"};
const storage=():Storage|null=>{try{return globalThis.sessionStorage??null;}catch{return null;}};
function parse(raw:string):{commandId:string;generation:string;principalBinding:string}|null{
 try{
   const v:unknown=JSON.parse(raw);
   if(!v||typeof v!=="object"||Array.isArray(v))return null;
   const x=v as Record<string,unknown>;
   return Object.keys(x).sort().join(",")==="commandId,generation,principalBinding"&&
     typeof x.commandId==="string"&&UUID.test(x.commandId)&&
     typeof x.generation==="string"&&BINDING.test(x.generation)&&
     typeof x.principalBinding==="string"&&BINDING.test(x.principalBinding)
     ?{commandId:x.commandId,generation:x.generation,principalBinding:x.principalBinding}:null;
 }catch{return null;}
}
export function projectTitleReloadMarker(generation:string):ProjectTitleReloadMarker{
 if(!BINDING.test(generation))return {kind:"unavailable"};
 try{
   const store=storage();if(!store)return {kind:"unavailable"};
   const raw=store.getItem(KEY);
   if(raw===null)return {kind:"clear"};
   const saved=parse(raw);
   return saved?{kind:"blocked",commandId:saved.commandId,principalBinding:saved.principalBinding}:
     {kind:"unavailable"};
 }catch{return {kind:"unavailable"};}
}
export function reserveProjectTitleReload(generation:string,commandId:string,principalBinding:string):boolean{
 if(!BINDING.test(generation)||!UUID.test(commandId)||!BINDING.test(principalBinding))return false;
 const existing=projectTitleReloadMarker(generation);
 if(existing.kind==="blocked")return existing.commandId===commandId&&existing.principalBinding===principalBinding;
 if(existing.kind!=="clear")return false;
 try{
   const store=storage();if(!store)return false;
   store.setItem(KEY,JSON.stringify({generation,commandId,principalBinding}));
   const checked=projectTitleReloadMarker(generation);
   return checked.kind==="blocked"&&checked.commandId===commandId&&checked.principalBinding===principalBinding;
 }catch{return false;}
}
/** Must only be called on an authenticated positive commit, or a definitive
 * FIRST dispatch rejection before any ambiguous transport outcome. */
function clearExact(commandId:string,principalBinding:string):boolean{
 if(!UUID.test(commandId)||!BINDING.test(principalBinding))return false;
 try{
   const store=storage();if(!store)return false;
   const raw=store.getItem(KEY);const value=raw===null?null:parse(raw);
   if(!value||value.commandId!==commandId||value.principalBinding!==principalBinding)return false;
   store.removeItem(KEY);
   return store.getItem(KEY)===null;
 }catch{return false;}
}
export const confirmProjectTitleReload=clearExact;
export const rejectFirstProjectTitleReload=clearExact;
