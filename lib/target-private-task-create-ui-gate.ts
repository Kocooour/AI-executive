/** R3-FE task capture intentionally reuses the already-authorized
 * private note Area catalogue and create-preview for a fresh Area/generation.
 * Therefore note create gates are REQUIRED as well as task write gates.
 * This UI gate is display only: task INSERT re-authorizes inside SQLite. */
import type {TargetUiEnv} from "./target-ui-config";
import {targetPrivateNoteCreateUiEnabled} from "./target-private-note-create-ui-gate";
export const TARGET_PRIVATE_TASK_CREATE_UI_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_PRIVATE_TASK_CREATE_ENABLED",
] as const;
export const targetPrivateTaskCreateUiEnabled=(env:TargetUiEnv):boolean=>
  targetPrivateNoteCreateUiEnabled(env)&&
  TARGET_PRIVATE_TASK_CREATE_UI_FLAGS.every(k=>env[k]==="true");
