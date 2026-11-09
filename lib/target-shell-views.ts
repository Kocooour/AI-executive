/** R3-FE-4a: which views of the main shell really render target data. Pure.
 * Details, unification and typed addresses act ONLY on these views; every other
 * view (Home, Inbox, legacy Today/Projects/Notes, ...) keeps its legacy behaviour. */
import type {TargetDetailGates,TargetDetailView} from "./target-detail-route";

export type TargetShellInput={
  scopesOn:boolean;projectsList:boolean;notesList:boolean;
  /** Target My Plan is enabled (flags) - it only exists in the v1 shell. */
  myPlan:boolean;v1Shell:boolean;
};
/** Views that can show target data with the given flags (independent of the current view). */
export function targetViewsFor(input:TargetShellInput):TargetDetailView[]{
  const views:TargetDetailView[]=[];
  if(input.scopesOn&&input.projectsList)views.push("Projects");
  if(input.scopesOn&&input.notesList)views.push("Notes");
  if(input.myPlan&&input.v1Shell)views.push("MyPlanPreview");
  return views;
}
/** Details exist only where a target list / plan exists to open them from. */
export function detailsActive(gates:TargetDetailGates,targetViews:readonly string[]):boolean{
  return targetViews.length>0&&(
    (gates.project&&targetViews.includes("Projects"))||
    (gates.note&&targetViews.includes("Notes"))||
    (gates.task&&(targetViews.includes("Projects")||targetViews.includes("MyPlanPreview"))));
}
/** The target view currently on screen, else null. */
export function activeTargetViewFor(input:TargetShellInput&{view:string;planActive:boolean}):
  {scopeList:"project"|"note"|null;targetPlan:boolean;active:TargetDetailView|null}{
  const targetPlan=input.myPlan&&input.v1Shell&&input.planActive&&input.view==="Today";
  const scopeList=input.scopesOn&&input.view==="Projects"&&input.projectsList?"project"
    :input.scopesOn&&input.view==="Notes"&&input.notesList?"note":null;
  const active:TargetDetailView|null=targetPlan?"MyPlanPreview"
    :scopeList==="project"?"Projects":scopeList==="note"?"Notes":null;
  return {scopeList,targetPlan,active};
}
