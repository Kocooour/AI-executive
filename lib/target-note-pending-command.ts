/** Tab-memory-only write guard. A command survives in-app navigation until its
 * read-only receipt is reconciled. It is never stored across reloads or actors. */
import type {EditCommand} from "./target-note-edit-client";
type Pending={generation:string;noteId:string;command:EditCommand};
let pending:Pending|null=null;
export function pendingNoteCommand(generation:string):Pending|null{
  if(!generation||pending?.generation!==generation){pending=null;return null;}
  return pending;
}
export function holdNoteCommand(generation:string,noteId:string,command:EditCommand):boolean{
  if(!generation||pendingNoteCommand(generation))return false;
  pending={generation,noteId,command};return true;
}
export function clearNoteCommand(generation:string,commandId:string):void{
  if(pending?.generation===generation&&pending.command.commandId===commandId)pending=null;
}
