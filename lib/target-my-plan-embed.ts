/** R3-FE-2: what the main app may show for the target My Plan, from the
 * runtime alone. The server list is requested ONLY in the "ready" state, which
 * exists only for a server-confirmed generation (runtime.known()). */
export type TargetMyPlanGate=
  |{kind:"checking"}
  |{kind:"signed_out"}
  |{kind:"ready";generation:string};
export type TargetMyPlanRuntimeView={known():boolean;generation():string};

export function targetMyPlanGate(
  runtime:TargetMyPlanRuntimeView|null,generation:string,
):TargetMyPlanGate {
  if(!runtime||generation==="")return {kind:"checking"};
  // Refused, signed out, revoked or disposed: never reusable, never data.
  if(!runtime.known()||runtime.generation()!==generation)return {kind:"signed_out"};
  return {kind:"ready",generation};
}
