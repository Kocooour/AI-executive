/** R3-FE-2: pure, serializable server config for target-data screens in the
 * main app. Env in, config out; no I/O. `null` means "target UI off": the page
 * then renders the legacy tree with no provider and no config at all.
 * Rendering permission is NOT an ACL grant: every request is still authorized
 * by the staging endpoints (session, Area ACL, CAS, restore barriers). */
import {TARGET_UI_FLAGS} from "./target-staging-session-generation";
import {myPlanStagingWriteUiEnabled} from "./target-staging-my-plan-ui-write-gate";
import {myPlanStagingWhenUiEnabled} from "./target-staging-my-plan-when-ui-gate";

export type TargetUiEnv=Record<string,string|undefined>;
export const TARGET_UI_MY_PLAN_FLAGS=[
  ...TARGET_UI_FLAGS,
  "AI_EXECUTIVE_TARGET_UI_MY_PLAN_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED",
] as const;
/** R3-FE-3: the global Vše / Osobní / Sdílené switcher. Each list view
 * additionally needs its own dedicated global index route (default-off on the
 * server); a view without its flag keeps the legacy list. */
export const TARGET_UI_SCOPES_FLAGS=[
  ...TARGET_UI_FLAGS,
  "AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED",
] as const;
export const TARGET_UI_SCOPES_PROJECTS_FLAG="AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED";
export const TARGET_UI_SCOPES_NOTES_FLAG="AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED";
/** R3-FE-4a: authorized details inside the main app. Each kind is gated by the
 * new UI flag AND the server flags its detail route requires; a kind without
 * all of them keeps today's behaviour (rows stay text). */
export const TARGET_UI_DETAILS_FLAGS=[
  ...TARGET_UI_FLAGS,
  "AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED",
] as const;
/** task: /api/target-staging/task-temporal/detail */
export const TARGET_UI_DETAIL_TASK_FLAG="AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED";
/** note: /api/target-staging/notes/[noteId] */
export const TARGET_UI_DETAIL_NOTE_FLAG="AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED";
/** project: /api/target-staging/projects/[projectId]/tasks needs only the base HTTP flag. */
/** R3-FE-4b: edits inside the authorized detail panel (default-off). Every control is
 * gated by the new UI flag AND the exact server flags of the routes it calls, including the
 * read-only preflight route that supplies its CAS / restore generation; one missing flag
 * removes just that control. Rendering permission is not an ACL grant. */
export const TARGET_UI_EDITS_FLAGS=[
  ...TARGET_UI_DETAILS_FLAGS,
  "AI_EXECUTIVE_TARGET_UI_EDITS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
] as const;
/** task title / delete: PATCH tasks/[id]/title, POST tasks/[id]/delete (+ /status receipts);
 * their CAS token, Area and restore generation come from the status preflight
 * (GET task-temporal/status), so its flags are required too. */
export const TARGET_UI_EDIT_TASK_CONTEXT_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED",
] as const;
export const TARGET_UI_EDIT_WHEN_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED",
] as const;
export const TARGET_UI_EDIT_NOTE_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
] as const;
export type TargetUiEdits={
  taskTitle:boolean;taskStatus:boolean;taskWhen:boolean;taskDelete:boolean;
  noteEdit:boolean;noteDelete:boolean;
};
export const NO_TARGET_UI_EDITS:TargetUiEdits={
  taskTitle:false,taskStatus:false,taskWhen:false,taskDelete:false,noteEdit:false,noteDelete:false,
};
export const anyTargetUiEdit=(edits:TargetUiEdits|undefined):boolean=>
  edits!==undefined&&Object.values(edits).some(Boolean);
export type TargetUiConfig={
  myPlan:{enabled:boolean;statusWrite:boolean;whenWrite:boolean};
  scopes:{enabled:boolean;projects:boolean;notes:boolean};
  details:{task:boolean;project:boolean;note:boolean};
  edits:TargetUiEdits;
};

/** The provider (and its session check) mounts only when some screen consumes it.
 * Details are no consumer of their own: they open only from a target list or the
 * target My Plan, so details flags without those stay inert (no provider, no request). */
export function targetDataNeeded(config:TargetUiConfig|null):boolean{
  return config!==null&&(config.myPlan.enabled||config.scopes.projects||config.scopes.notes);
}

export function targetUiConfig(env:TargetUiEnv):TargetUiConfig|null {
  if(!TARGET_UI_FLAGS.every(name=>env[name]==="true"))return null;
  const enabled=TARGET_UI_MY_PLAN_FLAGS.every(name=>env[name]==="true");
  const scopes=TARGET_UI_SCOPES_FLAGS.every(name=>env[name]==="true");
  const details=TARGET_UI_DETAILS_FLAGS.every(name=>env[name]==="true");
  const detailTask=details&&env[TARGET_UI_DETAIL_TASK_FLAG]==="true";
  const detailNote=details&&env[TARGET_UI_DETAIL_NOTE_FLAG]==="true";
  const all=(names:readonly string[])=>names.every(name=>env[name]==="true");
  const edits=all(TARGET_UI_EDITS_FLAGS);
  const taskContext=edits&&detailTask&&all(TARGET_UI_EDIT_TASK_CONTEXT_FLAGS);
  const noteWrite=edits&&detailNote&&all(TARGET_UI_EDIT_NOTE_FLAGS);
  return {details:{
    task:detailTask,
    project:details,
    note:detailNote,
  },edits:{
    taskTitle:taskContext,
    taskStatus:taskContext,
    taskWhen:edits&&detailTask&&all(TARGET_UI_EDIT_WHEN_FLAGS),
    taskDelete:taskContext,
    noteEdit:noteWrite,
    noteDelete:noteWrite,
  },scopes:{
    enabled:scopes,
    projects:scopes&&env[TARGET_UI_SCOPES_PROJECTS_FLAG]==="true",
    notes:scopes&&env[TARGET_UI_SCOPES_NOTES_FLAG]==="true",
  },myPlan:{
    enabled,
    // Write affordances exist only inside an enabled My Plan; each write gate
    // stays independent of the other.
    statusWrite:enabled&&myPlanStagingWriteUiEnabled(env),
    whenWrite:enabled&&myPlanStagingWhenUiEnabled(env),
  }};
}
