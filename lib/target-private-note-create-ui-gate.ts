/** Only the REAL private note create UI activates these write gates.
 * The read-only Area chooser remains independently usable with all writes OFF. */
import type {TargetUiEnv} from "./target-ui-config";
import {targetPrivateNoteAreaUiEnabled} from "./target-private-note-area-ui-gate";
export const TARGET_PRIVATE_NOTE_CREATE_UI_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_PRIVATE_NOTE_CREATE_ENABLED",
] as const;
export const targetPrivateNoteCreateUiEnabled=(env:TargetUiEnv)=>
  targetPrivateNoteAreaUiEnabled(env)&&
  TARGET_PRIVATE_NOTE_CREATE_UI_FLAGS.every(k=>env[k]==="true");
