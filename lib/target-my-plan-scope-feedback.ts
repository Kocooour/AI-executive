/** R3-FE-3: what to do with write feedback (Undo, receipts, failures) when the
 * global scope drives the plan filter. Feedback belongs to the scope that was
 * current when the first write of the series started. After a scope change,
 * each write family (status, When) is cleared as soon as IT has settled
 * (committed / error), independently of the other family; a pending, checking
 * or uncertain command is NEVER dropped, because its reconciliation must
 * survive. So a settled previous-scope Undo can never linger next to another
 * family's long-running uncertain reconciliation. */
export type FeedbackKind="idle"|"pending"|"checking"|"uncertain"|"committed"|"error"|string;
const inFlight=new Set<string>(["pending","checking","uncertain"]);
const settled=(kind:FeedbackKind)=>kind!=="idle"&&!inFlight.has(kind);

export function scopeFeedbackDecision(input:{
  recorded:string|null;current:string;statusKind:FeedbackKind;whenKind:FeedbackKind;
}):{recorded:string|null;clearStatus:boolean;clearWhen:boolean}{
  const none={clearStatus:false,clearWhen:false};
  if(input.statusKind==="idle"&&input.whenKind==="idle")return {recorded:null,...none};
  if(input.recorded===null)return {recorded:input.current,...none};
  if(input.recorded===input.current)return {recorded:input.recorded,...none};
  const clearStatus=settled(input.statusKind);
  const clearWhen=settled(input.whenKind);
  // Remaining in-flight work still belongs to the recorded (previous) scope.
  const stillBusy=inFlight.has(input.statusKind)||inFlight.has(input.whenKind);
  return {recorded:stillBusy?input.recorded:null,clearStatus,clearWhen};
}
