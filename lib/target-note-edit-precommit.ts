/** Application-issued, content-free acknowledgement that no note PATCH committed.
 * Only stamp failures on paths which have not dispatched a write, or a child
 * result which transactionally guarantees no commit. A proxy/WAF status alone
 * can never serve as this acknowledgement.
 */
export const NOTE_EDIT_COMMAND_HEADER="x-lumi-note-edit-command-id";
export const NOTE_EDIT_PRECOMMIT_HEADER="x-lumi-note-edit-precommit";
export const NOTE_EDIT_PRECOMMIT_VALUE="1";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Preserve existing response bodies/statuses for other staging clients. */
export function stampNoteEditPrecommit(request:Request,response:Response):Response{
  const commandId=request.headers.get(NOTE_EDIT_COMMAND_HEADER);
  if(!commandId||!uuid.test(commandId)||
      (response.status!==400&&response.status!==403&&
       response.status!==404&&response.status!==409))return response;
  const headers=new Headers(response.headers);
  headers.set(NOTE_EDIT_PRECOMMIT_HEADER,NOTE_EDIT_PRECOMMIT_VALUE);
  headers.set(NOTE_EDIT_COMMAND_HEADER,commandId);
  return new Response(response.body,{status:response.status,headers});
}
