/** UI-09e: destination-only URLs for explicitly enabled staging read previews.
 * A title or ID found in an authorized index is NOT a detail-read capability.
 * Each destination must still perform a new server-side actor/Area ACL check. */
export type StagingIndexKind="project"|"task"|"note";
export type StagingIndexDetailGates={project:boolean;note:boolean;task?:boolean};

const textEncoder=new TextEncoder();
const controls=/[\u0000-\u001f\u007f]/u;

/** Deliberately narrower than the index ID schema: no ambiguous URL segments. */
export function stagingIndexDetailHref(
  kind:StagingIndexKind,id:unknown,gates:StagingIndexDetailGates,
):string|null{
  if(kind!=="project"&&kind!=="note"&&kind!=="task")return null;
  if(!gates||gates[kind]!==true||
    typeof id!=="string"||id.length===0||id==="."||id===".."||
    id.trim()!==id||controls.test(id)||id.includes("/")||id.includes("\\"))return null;
  try{
    const segment=encodeURIComponent(id); // also rejects unpaired UTF-16 surrogates
    if(textEncoder.encode(id).byteLength>512||!segment)return null;
    return "/target-staging/"+(kind==="project"?"projects":kind==="note"?"notes":"tasks")+
      "/"+segment+"/preview";
  }catch{return null;}
}
