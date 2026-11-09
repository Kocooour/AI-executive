/** R3-FE-3: what to do with write feedback (Undo, receipts, failures) when the
 * global scope drives the plan filter. Feedback belongs to the scope that was
 * current when the first write of the series started. Once nothing is in
 * flight and the scope differs, it is cleared; but a pending, checking or
 * uncertain command is NEVER dropped, because its reconciliation must survive. */
export type FeedbackKind="idle"|"pending"|"checking"|"uncertain"|"committed"|"error"|string;
const inFlight=new Set<string>(["pending","checking","uncertain"]);

export function scopeFeedbackDecision(input:{
  recorded:string|null;current:string;statusKind:FeedbackKind;whenKind:FeedbackKind;
}):{recorded:string|null;clear:boolean}{
  const idle=input.statusKind==="idle"&&input.whenKind==="idle";
  if(idle)return {recorded:null,clear:false};
  if(input.recorded===null)return {recorded:input.current,clear:false};
  if(input.recorded===input.current)return {recorded:input.recorded,clear:false};
  const busy=inFlight.has(input.statusKind)||inFlight.has(input.whenKind);
  return busy?{recorded:input.recorded,clear:false}:{recorded:null,clear:true};
}
