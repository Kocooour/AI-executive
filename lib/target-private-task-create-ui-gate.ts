/** R3-FE-6: task capture reuses the already authorized private Area chooser
 * and create-preview transport. No new server-only credential reaches the
 * browser; both note Area transport and task-write gates must be active.
 * Default-off by design, independently from task HTTP enablement. */
import type {TargetUiEnv} from "./target-ui-config";
import {targetPrivateNoteCreateUiEnabled} from "./target-private-note-create-ui-gate";

export const TARGET_PRIVATE_TASK_CREATE_UI_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_PRIVATE_TASK_CREATE_ENABLED",
] as const;

export const targetPrivateTaskCreateUiEnabled=(env:TargetUiEnv):boolean=>
  targetPrivateNoteCreateUiEnabled(env)&&
  TARGET_PRIVATE_TASK_CREATE_UI_FLAGS.every(name=>env[name]==="true");
