/** R3 A/3: two independent default-off main-UI create controls.
 * UI flags never authorize an Area or a parent; server rechecks at commit. */
import type {TargetUiEnv} from "./target-ui-config";
import {TARGET_UI_FLAGS} from "./target-staging-session-generation";
import {targetPrivateNoteAreaUiEnabled} from "./target-private-note-area-ui-gate";

export const TARGET_PRIVATE_PROJECT_CREATE_FLAGS=[
  ...TARGET_UI_FLAGS,
  "AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_PRIVATE_PROJECT_CREATE_ENABLED",
] as const;
export const TARGET_PROJECT_TASK_CREATE_FLAGS=[
  ...TARGET_UI_FLAGS,
  "AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_PROJECT_TASK_CREATE_ENABLED",
] as const;
export const targetPrivateProjectCreateUiEnabled=(env:TargetUiEnv):boolean=>
  targetPrivateNoteAreaUiEnabled(env)&&
  TARGET_PRIVATE_PROJECT_CREATE_FLAGS.every(name=>env[name]==="true");
export const targetProjectTaskCreateUiEnabled=(env:TargetUiEnv):boolean=>
  targetPrivateNoteAreaUiEnabled(env)&&
  TARGET_PROJECT_TASK_CREATE_FLAGS.every(name=>env[name]==="true");
