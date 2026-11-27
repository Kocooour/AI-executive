/** Volatile draft, scoped to one authorized actor/task and observed date snapshot.
 * A checking state is not permission to display or write, but can retain a
 * user's draft in memory until the same snapshot has been re-authorized. */
export type DateDraft={value:string;confirming:boolean};
export type DateDraftRecord={identity:string;snapshot:string;draft:DateDraft;resetNotice:boolean};
export type DateDraftContext={identity:string;snapshot:string;value:string|null;allowed:boolean|null};
export const initialDateDraft=(value:string|null):DateDraft=>({value:value??"",confirming:false});
export function reconcileDateDraft(record:DateDraftRecord|null,context:DateDraftContext):DateDraftRecord|null{
  if(!record||record.identity!==context.identity||context.allowed===false)return null;
  if(context.allowed===null||record.snapshot===context.snapshot)return record;
  return {identity:context.identity,snapshot:context.snapshot,
    draft:initialDateDraft(context.value),resetNotice:true};
}
export function displayedDateDraft(record:DateDraftRecord|null,context:DateDraftContext):DateDraft{
  const current=reconcileDateDraft(record,context);
  return context.allowed===true&&current?.snapshot===context.snapshot
    ?current.draft:initialDateDraft(context.value);
}
