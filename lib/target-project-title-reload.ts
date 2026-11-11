/** Content-free, per actor+project tab markers. Unlike a global marker, another
 * authenticated actor is never shown or blocked by a prior actor's command.
 * The old marker is retained until its own positive receipt or definitive
 * FIRST-dispatch rejection; CAS protects concurrent edits to one project.
 * Legacy single-marker JSON remains readable and is upgraded on next write.
 */
const KEY="lumi-target-project-title-unresolved-v1";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING=/^[A-Za-z0-9_-]{43}$/;
const MAX_MARKERS=32;
type Marker={commandId:string;principalBinding:string};
export type ProjectTitleReloadMarker={kind:"clear"}|
  {kind:"blocked";commandId:string;principalBinding:string}|{kind:"unavailable"};
const storage=():Storage|null=>{try{return globalThis.sessionStorage??null;}catch{return null;}};
function marker(value:unknown):value is Marker{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const x=value as Record<string,unknown>;
  return Object.keys(x).sort().join(",")==="commandId,principalBinding"&&
    typeof x.commandId==="string"&&UUID.test(x.commandId)&&
    typeof x.principalBinding==="string"&&BINDING.test(x.principalBinding);
}
function parse(raw:string):Marker[]|null{
  try{
    const value:unknown=JSON.parse(raw);
    if(!value||typeof value!=="object"||Array.isArray(value))return null;
    const x=value as Record<string,unknown>;
    if(Object.keys(x).sort().join(",")==="commandId,generation,principalBinding"&&
       typeof x.generation==="string"&&BINDING.test(x.generation)){
      const old={commandId:x.commandId,principalBinding:x.principalBinding};
      return marker(old)?[old]:null;
    }
    if(Object.keys(x).sort().join(",")!=="entries,version"||x.version!==2||
       !Array.isArray(x.entries)||x.entries.length>MAX_MARKERS)return null;
    const all=x.entries as unknown[];
    if(!all.every(marker))return null;
    const records=all as Marker[];
    if(new Set(records.map(v=>v.principalBinding)).size!==records.length)return null;
    return records;
  }catch{return null;}
}
/** Without a NEW server-verified project principal proof, never reveal a
 * prior command UUID or even whether it belongs to the current actor. */
export function projectTitleReloadMarker(generation:string,principalBinding?:string):ProjectTitleReloadMarker{
  if(!BINDING.test(generation))return {kind:"unavailable"};
  try{
    const store=storage();if(!store)return {kind:"unavailable"};
    const raw=store.getItem(KEY);
    if(raw===null)return {kind:"clear"};
    const records=parse(raw);
    if(records===null||!principalBinding||!BINDING.test(principalBinding))return {kind:"unavailable"};
    const found=records.find(v=>v.principalBinding===principalBinding);
    return found?{kind:"blocked",...found}:{kind:"clear"};
  }catch{return {kind:"unavailable"};}
}
export function reserveProjectTitleReload(generation:string,commandId:string,principalBinding:string):boolean{
  if(!BINDING.test(generation)||!UUID.test(commandId)||!BINDING.test(principalBinding))return false;
  try{
    const store=storage();if(!store)return false;
    const raw=store.getItem(KEY),records=raw===null?[]:parse(raw);
    if(records===null)return false;
    const found=records.find(v=>v.principalBinding===principalBinding);
    if(found)return found.commandId===commandId;
    if(records.length>=MAX_MARKERS)return false;
    store.setItem(KEY,JSON.stringify({version:2,entries:[...records,{commandId,principalBinding}]}));
    const saved=projectTitleReloadMarker(generation,principalBinding);
    return saved.kind==="blocked"&&saved.commandId===commandId;
  }catch{return false;}
}
/** Remove only the matching actor/project barrier; never clear another actor. */
function clearExact(commandId:string,principalBinding:string):boolean{
  if(!UUID.test(commandId)||!BINDING.test(principalBinding))return false;
  try{
    const store=storage();if(!store)return false;
    const raw=store.getItem(KEY),records=raw===null?null:parse(raw);
    if(!records||!records.some(v=>v.commandId===commandId&&v.principalBinding===principalBinding))return false;
    const remaining=records.filter(v=>v.commandId!==commandId||v.principalBinding!==principalBinding);
    if(remaining.length>0)store.setItem(KEY,JSON.stringify({version:2,entries:remaining}));
    else store.removeItem(KEY);
    return projectTitleReloadMarker("A".repeat(43),principalBinding).kind==="clear";
  }catch{return false;}
}
export const confirmProjectTitleReload=clearExact;
export const rejectFirstProjectTitleReload=clearExact;
