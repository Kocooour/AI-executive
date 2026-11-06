/** R3 UI-03b: pure guard for manually retrying a READ after an uncertain write.
 * The original CAS command stays in the caller's volatile ref; this path must
 * never dispatch a second PATCH, clear the command, or reveal cached task rows.
 * A successful read is needed before the separate actor-bound receipt check. */
export function canRetryUncertainMyPlanRead({
  statusWriteEnabled,actionKind,readStatus,hasOriginalCommand,
  operationInFlight,visible,online,
}:{
  statusWriteEnabled:boolean;
  actionKind:"idle"|"pending"|"checking"|"uncertain"|"committed"|"error";
  readStatus:"loading"|"ready"|"error";
  hasOriginalCommand:boolean;
  operationInFlight:boolean;
  visible:boolean;
  online:boolean;
}):boolean{
  return statusWriteEnabled&&actionKind==="uncertain"&&
    readStatus==="error"&&hasOriginalCommand&&!operationInFlight&&
    visible&&online;
}
