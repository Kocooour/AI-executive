/** R3-FE-4b: independent note-edit UI switch. Never widens server permissions.
 * A read-only note detail remains available when any write gate is absent. */
import type {TargetUiEnv} from "./target-ui-config";

export const TARGET_NOTE_EDIT_UI_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_NOTE_EDIT_ENABLED",
] as const;

export function targetNoteEditUiEnabled(env:TargetUiEnv):boolean{
  return TARGET_NOTE_EDIT_UI_FLAGS.every(flag=>env[flag]==="true");
}
