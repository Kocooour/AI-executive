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
export type TargetUiConfig={
  myPlan:{enabled:boolean;statusWrite:boolean;whenWrite:boolean};
  scopes:{enabled:boolean;projects:boolean;notes:boolean};
};

export function targetUiConfig(env:TargetUiEnv):TargetUiConfig|null {
  if(!TARGET_UI_FLAGS.every(name=>env[name]==="true"))return null;
  const enabled=TARGET_UI_MY_PLAN_FLAGS.every(name=>env[name]==="true");
  const scopes=TARGET_UI_SCOPES_FLAGS.every(name=>env[name]==="true");
  return {scopes:{
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
