/** R3-FE-4a: which views of the main shell really render target data. Pure.
 * Details, unification and typed addresses act ONLY on these views; every other
 * view (Home, Inbox, legacy Today/Projects/Notes, ...) keeps its legacy behaviour. */
import type {TargetDetailGates,TargetDetailView} from "./target-detail-route";

export type TargetShellInput={
  scopesOn:boolean;projectsList:boolean;notesList:boolean;
  /** Target My Plan is enabled (flags) - it only exists in the v1 shell. */
  myPlan:boolean;v1Shell:boolean;personalV1?:boolean;homeRead?:boolean;inboxRead?:boolean;
};
/** Views that can show target data with the given flags (independent of the current view). */
export function targetViewsFor(input:TargetShellInput):TargetDetailView[]{
  const views:TargetDetailView[]=[];
  if(input.scopesOn&&input.projectsList)views.push("Projects");
  if(input.scopesOn&&input.notesList)views.push("Notes");
  if(input.myPlan&&input.v1Shell)views.push("MyPlanPreview");
  if(input.personalV1&&input.homeRead)views.push("Home","Upcoming");
  if(input.personalV1&&input.homeRead&&input.inboxRead)views.push("Inbox");
  return views;
}
/** Details exist only where a target list / plan exists to open them from. */
export function detailsActive(gates:TargetDetailGates,targetViews:readonly string[]):boolean{
  return targetViews.length>0&&(
    (gates.project&&targetViews.includes("Projects"))||
    (gates.note&&targetViews.includes("Notes"))||
    (gates.task&&(targetViews.includes("Projects")||targetViews.includes("MyPlanPreview")||
      targetViews.includes("Home")||targetViews.includes("Upcoming")||targetViews.includes("Inbox"))));
}
/** The target view currently on screen, else null. */
export function activeTargetViewFor(input:TargetShellInput&{view:string;planActive:boolean}):
  {scopeList:"project"|"note"|null;targetPlan:boolean;active:TargetDetailView|null}{
  const targetPlan=input.myPlan&&input.v1Shell&&input.planActive&&input.view==="Today";
  const scopeList=input.scopesOn&&input.view==="Projects"&&input.projectsList?"project"
    :input.scopesOn&&input.view==="Notes"&&input.notesList?"note":null;
  const active:TargetDetailView|null=input.personalV1&&input.homeRead&&
    (input.view==="Home"||input.view==="Upcoming")?input.view
    :input.personalV1&&input.homeRead&&input.inboxRead&&input.view==="Inbox"?"Inbox"
    :targetPlan?"MyPlanPreview"
    :scopeList==="project"?"Projects":scopeList==="note"?"Notes":null;
  return {scopeList,targetPlan,active};
}
/** D (#501): personal-v1 exposes current views only. Obsolete Archive links
 * are redirected to My Plan by the client router; off mode is unchanged. */
export const RETIRED_ARCHIVE_VIEWS = Object.freeze([
  "LegacyHome", "LegacyInbox", "LegacyUpcoming", "Today", "Overdue",
  "Anytime", "Someday", "Completed", "Areas", "Context",
]);
export function retiredArchiveView(view: string): boolean {
  return RETIRED_ARCHIVE_VIEWS.includes(view);
}

/** C-1: one pure classification for every addressable shell view. Never use
 * legacy list membership/counts to decide whether a target view is current.
 * personal-v1 is an all-gates opt-in; incomplete configurations and 'off'
 * keep their existing navigation rather than advertising legacy data as live.
 * Quick Capture is a target action, not a view/address. */
export const SHELL_NAVIGATION_VIEWS=[
  "MyPlanPreview","Home","LegacyHome","Inbox","LegacyInbox","Today","Upcoming","LegacyUpcoming","Projects","Areas","Notes",
  "Calendar","Search","Overdue","Anytime","Someday","Completed","Context",
  "Agents","Settings",
] as const;
export type ShellNavigationView=(typeof SHELL_NAVIGATION_VIEWS)[number];
export type ShellNavigationPlacement="primary"|"archive"|"hidden";
export type ShellNavigationModel={
  personalV1:boolean;
  byView:Readonly<Record<ShellNavigationView,ShellNavigationPlacement>>;
  primary:readonly ShellNavigationView[];
  archive:readonly ShellNavigationView[];
  hidden:readonly ShellNavigationView[];
  quickCapture:boolean;
};
export type ShellNavigationInput=TargetShellInput&{
  /** The main authorized title search, not the legacy search. */
  targetSearch:boolean;
  /** Global target private capture is ready; never fall back to legacy capture. */
  quickCapture:boolean;
};
const PERSONAL_V1_C1_PRIMARY:readonly ShellNavigationView[]=[
  "MyPlanPreview","Projects","Notes","Calendar","Search",
];
const PERSONAL_V1_PRIMARY:readonly ShellNavigationView[]=[
  "MyPlanPreview","Home","Upcoming","Projects","Notes","Calendar","Search",
];
const PERSONAL_V1_INBOX_PRIMARY:readonly ShellNavigationView[]=[
  "MyPlanPreview","Home","Inbox","Upcoming","Projects","Notes","Calendar","Search",
];
/** System views (Agents, Settings) remain accessible outside primary/archive. */
export function targetShellNavigationFor(input:ShellNavigationInput):ShellNavigationModel{
  const personalV1=input.v1Shell&&input.scopesOn&&input.projectsList&&
    input.notesList&&input.myPlan&&input.targetSearch&&input.quickCapture;
  const inboxReady=personalV1&&Boolean(input.homeRead&&input.inboxRead);
  const primary=personalV1?(inboxReady?PERSONAL_V1_INBOX_PRIMARY:
    input.homeRead?PERSONAL_V1_PRIMARY:PERSONAL_V1_C1_PRIMARY):[];
  const archive:readonly ShellNavigationView[]=[];
  const primarySet=new Set<string>(primary);
  const byView=Object.fromEntries(SHELL_NAVIGATION_VIEWS.map(view=>
    [view,primarySet.has(view)?"primary":"hidden"]
  )) as Record<ShellNavigationView,ShellNavigationPlacement>;
  return {personalV1,byView,primary,archive,
    hidden:SHELL_NAVIGATION_VIEWS.filter(view=>byView[view]==="hidden"),
    quickCapture:personalV1&&input.quickCapture};
}
// The four approved bottom tabs are MyPlanPreview / Calendar / Projects / More.
// Everything else from the *typed* primary set belongs to More → Current.
// In particular the target Inbox must not silently disappear from mobile.
export function targetMobileMoreCurrentViews(navigation:ShellNavigationModel):ShellNavigationView[]{
  return navigation.primary.filter(view=>
    view!=="MyPlanPreview"&&view!=="Calendar"&&view!=="Projects");
}

/** Historical Gmail belongs to the former Inbox until *target* Inbox is activated.
 * Once active, new Inbox never has the old Gmail or legacy create action. */
export function legacyInboxMailViewFor(personalV1:boolean,targetInboxEnabled:boolean):"Inbox"|"LegacyInbox"{
  return personalV1&&targetInboxEnabled?"LegacyInbox":"Inbox";
}
