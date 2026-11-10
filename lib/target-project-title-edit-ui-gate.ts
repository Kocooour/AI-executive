/** Independent opt-in for project rename UI; the server still authorizes each write. */
import type {TargetUiEnv} from './target-ui-config';
export const TARGET_PROJECT_TITLE_EDIT_UI_FLAGS=[
  'AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED',
  'AI_EXECUTIVE_TARGET_UI_ENABLED',
  'AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED',
  'AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED',
  'AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED',
  'AI_EXECUTIVE_TARGET_UI_PROJECT_EDIT_ENABLED',
  // Independent last-mile opt-in: exact same actor proof + guarded receipt
  // recovery must be enabled explicitly on a reviewed staging installation.
  'AI_EXECUTIVE_TARGET_UI_PROJECT_REAUTH_RECOVERY_ENABLED',
] as const;
export function targetProjectTitleEditUiEnabled(env:TargetUiEnv):boolean{
  return TARGET_PROJECT_TITLE_EDIT_UI_FLAGS.every(flag=>env[flag]==='true');
}
export const TARGET_PROJECT_TITLE_UPDATED='lumi-target-project-title-updated';
