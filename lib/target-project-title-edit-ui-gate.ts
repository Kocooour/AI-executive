/** Independent opt-in for project rename UI; the server still authorizes each write. */
import type {TargetUiEnv} from './target-ui-config';
export const TARGET_PROJECT_TITLE_EDIT_UI_FLAGS=[
  'AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED',
  'AI_EXECUTIVE_TARGET_UI_ENABLED',
  'AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED',
  'AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED',
  'AI_EXECUTIVE_TARGET_UI_PROJECT_EDIT_ENABLED',
] as const;
export function targetProjectTitleEditUiEnabled(env:TargetUiEnv):boolean{
  // Hard-disabled until the project command is retained across session_expired
  // and recovered only after server-verified reauthentication of the SAME identity.
  // An environment flag cannot override this safety boundary.
  void env;
  return false;
}
export const TARGET_PROJECT_TITLE_UPDATED='lumi-target-project-title-updated';
