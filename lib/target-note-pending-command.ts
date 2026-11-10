/** The command stays in memory. A content-free tab marker survives reload so an
 * uncertain write cannot silently become a new edit after its receipt is lost. */
import type {EditCommand} from "./target-note-edit-client";
type Pending={generation:string;noteId:string;command:EditCommand};
let pending:Pending|null=null;
const marker="lumi-target-note-edit-unresolved-v1";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const serverGeneration=/^[A-Za-z0-9_-]{43}$/;
type Marker={commandId:string;generation:string};
function parseMarker(value:string):Marker|null{
  try{const parsed:unknown=JSON.parse(value);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return null;
    const v=parsed as Record<string,unknown>;
    return Object.keys(v).sort().join(",")==="commandId,generation"&&
      typeof v.commandId==="string"&&uuid.test(v.commandId)&&
      typeof v.generation==="string"&&serverGeneration.test(v.generation)
      ?{commandId:v.commandId,generation:v.generation}:null;
  }catch{return null;}
}
function tabStorage():Storage|null{
  try{return globalThis.sessionStorage??null;}catch{return null;}
}
/** Missing/denied storage fails closed: a reload must not erase write history. */
export function noteEditBlocked(generation:string):boolean{
  if(!generation)return true;
  if(pendingNoteCommand(generation))return true;
  try{
    const storage=tabStorage();if(!storage)return true;
    const value=storage.getItem(marker);if(value===null)return false;
    const saved=parseMarker(value);
    // An unknown/local generation is not proof of an identity transition.
    if(!saved||!serverGeneration.test(generation)||saved.generation===generation)return true;
    storage.removeItem(marker);
    return storage.getItem(marker)!==null;
  }catch{return true;}
}
/** A random correlation ID is not a receipt capability. The server must
 * independently check the current actor and note ACL before answering. */
export function lostNoteCommandId(generation:string):string|null{
  if(!generation||!noteEditBlocked(generation)||pendingNoteCommand(generation))return null;
  try{const value=tabStorage()?.getItem(marker);const saved=value?parseMarker(value):null;
    return saved?.generation===generation?saved.commandId:null;}
  catch{return null;}
}
export function pendingNoteCommand(generation:string):Pending|null{
  if(!generation||pending?.generation!==generation){pending=null;return null;}
  return pending;
}
export function holdNoteCommand(generation:string,noteId:string,command:EditCommand):boolean{
  if(noteEditBlocked(generation))return false;
  try{const storage=tabStorage();if(!storage||!serverGeneration.test(generation)||!uuid.test(command.commandId))return false;
    storage.setItem(marker,JSON.stringify({commandId:command.commandId,generation}));}
  catch{return false;}
  pending={generation,noteId,command};return true;
}
export function clearRecoveredNoteCommand(generation:string,commandId:string):void{
  if(!generation||pendingNoteCommand(generation)||!uuid.test(commandId))return;
  try{const storage=tabStorage();const saved=storage?.getItem(marker);
    if(saved&&parseMarker(saved)?.commandId===commandId)storage?.removeItem(marker);}
  catch{/* remain blocked */}
}
export function clearNoteCommand(generation:string,commandId:string):void{
  if(pending?.generation===generation&&pending.command.commandId===commandId){
    pending=null;
    try{const storage=tabStorage();const saved=storage?.getItem(marker);
      if(saved&&parseMarker(saved)?.commandId===commandId)storage?.removeItem(marker);}
    catch{/* remain blocked */}
  }
}
