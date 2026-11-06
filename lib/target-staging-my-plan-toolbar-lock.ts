/** UI-04b: shared synchronous guard for read-context changes.
 * React's disabled button and queued state update are NOT a mutex: an event
 * may arrive before the next render while a request ref already exists.
 * This guard reads BOTH refs from the actual event handler. */
export function myPlanToolbarChangeBlocked({
  anyPending,statusInFlight,whenInFlight,
}:{
  anyPending:boolean;statusInFlight:boolean;whenInFlight:boolean;
}):boolean{
  return anyPending||statusInFlight||whenInFlight;
}
