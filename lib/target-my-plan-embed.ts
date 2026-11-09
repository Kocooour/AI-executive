/** R3-FE-2: what the main app may show for the target My Plan, from the
 * runtime alone. The server list is requested ONLY in the "ready" state, which
 * exists only for a server-confirmed generation (runtime.known()). */
export type TargetMyPlanGate=
  |{kind:"checking"}
  |{kind:"signed_out"}
  |{kind:"unavailable"}
  |{kind:"feature_off"}
  |{kind:"refused"}
  |{kind:"ready";generation:string};
export type TargetMyPlanOutcome="ok"|"signed_out"|"unavailable"|"feature_off";
export type TargetMyPlanRuntimeView={known():boolean;generation():string};

export function targetMyPlanGate(
  runtime:TargetMyPlanRuntimeView|null,generation:string,
  outcome:TargetMyPlanOutcome|null=null,blocked=false,
):TargetMyPlanGate {
  if(!runtime)return {kind:"checking"};
  // Repeated refusals right after a confirmed generation: stop the loop and
  // keep nothing on screen until an explicit user action or a new generation.
  if(blocked)return {kind:"refused"};
  if(outcome==="feature_off"&&!runtime.known())return {kind:"feature_off"};
  if(generation===""){
    return outcome==="unavailable"?{kind:"unavailable"}:{kind:"checking"};
  }
  // Refused, signed out, revoked or disposed: never reusable, never data.
  if(!runtime.known()||runtime.generation()!==generation){
    return outcome==="unavailable"?{kind:"unavailable"}:{kind:"signed_out"};
  }
  return {kind:"ready",generation};
}

/** Bounds refusal → re-verify → remount cycles. A refusal is admitted (the
 * runtime may re-verify) at most `limit` times per `windowMs`; beyond that the
 * screen stays refused until reset (user action or a new generation). */
export function createRefusalBudget({limit=2,windowMs=60_000,now=()=>Date.now()}:{
  limit?:number;windowMs?:number;now?:()=>number;
}={}){
  let times:number[]=[];
  return {
    admit():boolean{
      const t=now();
      times=times.filter(x=>t-x<windowMs);
      if(times.length>=limit)return false;
      times.push(t);
      return true;
    },
    reset():void{times=[];},
  };
}
