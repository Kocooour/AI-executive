/** UI-02: wall-clock lifecycle for a staging-only actor-private My Plan view.
 * Only derived calendar dates/timing. This module never reads task content. */
import {localMyPlanDate} from "./target-staging-my-plan-client";

const MAX_TIMER_DELAY=2_147_483_647;

/** A local constructor (not UTC + 24h) handles DST's 23h/25h days. */
export function msUntilNextLocalMyPlanDay(now=new Date()):number {
  if(!Number.isFinite(now.getTime()))return 1000;
  const midnight=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  const elapsed=midnight.getTime()-now.getTime();
  return Math.max(1,Math.min(MAX_TIMER_DELAY,elapsed));
}

export function resumeMyPlanDate(
  evaluationDate:string|null,followToday:boolean,now=new Date(),
):{evaluationDate:string|null;changed:boolean}{
  const today=localMyPlanDate(now);
  return followToday&&evaluationDate!==today
    ?{evaluationDate:today,changed:true}
    :{evaluationDate,changed:false};
}
