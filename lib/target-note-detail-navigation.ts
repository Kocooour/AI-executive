/** URL is a selector only. The detail always obtains a fresh server ACL read. */
import {validNotePreviewId} from "./target-staging-note-preview-client";

const prefix="#target-note=";
export function noteIdFromHash(hash:string):string|null{
  if(!hash.startsWith(prefix))return null;
  try{
    const id=decodeURIComponent(hash.slice(prefix.length));
    return validNotePreviewId(id)&&noteHash(id)===hash?id:null;
  }catch{return null;}
}
export function noteHash(id:string):string{
  if(!validNotePreviewId(id))throw new TypeError("Invalid note ID");
  return prefix+encodeURIComponent(id);
}
