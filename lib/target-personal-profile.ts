/** Release scope "one owner, private Areas only" (decision 2026-11-12): the exact
 * boolean target flags of the single-owner private-Area daily loop. Pure data, no I/O:
 * the app never reads a profile variable, activation stays per flag. A flag set to
 * "true" is rendering/route permission only, never an ACL grant. Every new
 * AI_EXECUTIVE_TARGET_*_ENABLED flag must be classified in exactly one of the two lists
 * (tests/target-personal-profile.test.mjs). */

/** Alphabetically sorted. Covers: target UI runtime, My Plan (read, status, When, Undo),
 * Vše/Osobní/Sdílené scopes for projects and notes, task/project/note details, edits
 * (task title/status/When/delete, note edit/delete, project title incl. reauth recovery),
 * main title search, private note Areas chooser + private note create, private task create. */
export const TARGET_PERSONAL_V1_PROFILE=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_STATUS_UI_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_WHEN_UI_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_EDITS_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_MY_PLAN_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_NOTE_EDIT_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_PRIVATE_NOTE_AREAS_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_PRIVATE_NOTE_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_PRIVATE_TASK_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_PROJECT_EDIT_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_PROJECT_REAUTH_RECOVERY_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_TITLE_SEARCH_ENABLED",
] as const;

/** Flags deliberately NOT part of the profile, each with the reason. */
export const TARGET_PERSONAL_V1_EXCLUDED:readonly {readonly flag:string;readonly reason:string}[]=[
  {flag:"AI_EXECUTIVE_TARGET_STAGING_GLOBAL_INDEX_CLIENT_PREVIEW_ENABLED",reason:"Client preview page, not the main app."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED",reason:"Attention is out of scope for the personal daily loop."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_WRITE_ENABLED",reason:"Attention lifecycle writes are out of scope."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED",reason:"Combined index feeds only the preview page; the main app uses per-kind indexes."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_TASKS_ENABLED",reason:"Task index is not consumed by the main app UI; tasks come from My Plan."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED",reason:"Target Home summary replaces legacy Home, which is out of scope."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED",reason:"Offline note sync is not part of the server-rendered daily loop."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED",reason:"Notifications/push are out of scope."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_WRITE_ENABLED",reason:"Notification settings writes are out of scope."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED",reason:"Backend-only private project creation, pending milestone A/3 UI."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED",reason:"Backend-only private project-child task creation, pending milestone A/3 UI."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED",reason:"Relations/backlinks are not used by the listed UI."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED",reason:"Shared deadline writes; the loop uses the actor-private When."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_WINDOWS_ENABLED",reason:"Due-window reads are not consumed by the listed UI."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_INDEX_DETAIL_LINKS_ENABLED",reason:"Preview-page detail links."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_CLIENT_PREVIEW_ENABLED",reason:"Client preview page, not the main app."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_NOTE_CLIENT_PREVIEW_ENABLED",reason:"Client preview page, not the main app."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_PROJECT_TASKS_CLIENT_PREVIEW_ENABLED",reason:"Client preview page, not the main app."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_TASK_CLIENT_PREVIEW_ENABLED",reason:"Client preview page, not the main app."},
  {flag:"AI_EXECUTIVE_TARGET_STAGING_TITLE_SEARCH_CLIENT_PREVIEW_ENABLED",reason:"Client preview page, not the main app."},
];

/** Non-boolean settings (not flags) an operator MUST also provide for the profile to work. Each names the
 * exact variable; none is a secret in the profile itself (values are per installation). */
export const TARGET_PERSONAL_V1_REQUIRED_SETTINGS:readonly {readonly name:string;readonly reason:string}[]=[
  {name:"AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",reason:"Absolute path of the isolated target store directory (never the live data dir)."},
  {name:"AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",reason:"The single owner identity the owner cookie maps to."},
  {name:"AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",reason:"UUID restore generation of that store."},
];

/** Other non-boolean AI_EXECUTIVE_TARGET_* names that exist in the sources but are NOT operator settings
 * of this profile (set internally for child processes, derived, or belonging to an excluded feature). */
export const TARGET_PERSONAL_V1_NOT_SETTINGS:readonly {readonly name:string;readonly reason:string}[]=[
  {name:"AI_EXECUTIVE_TARGET_STAGING_SESSION_HASH",reason:"Passed by the server to its own read child only."},
  {name:"AI_EXECUTIVE_TARGET_STAGING_PROJECT_TITLE_PROOF_KEY",reason:"Child-only key derived from AI_EXECUTIVE_SESSION_SECRET; not set by operators."},
  {name:"AI_EXECUTIVE_TARGET_STAGING_NOTE_SYNC_SECRET",reason:"Belongs to the excluded note-sync feature."},
];

/** Whole families that are never part of the profile (not AI_EXECUTIVE_TARGET_*). */
export const TARGET_PERSONAL_V1_EXCLUDED_PREFIXES:readonly {readonly prefix:string;readonly reason:string}[]=[
  {prefix:"AI_EXECUTIVE_HUMANWIKI_",reason:"HumanWiki is a separate, out-of-scope integration."},
];

/** Env for an isolated instance: every profile flag set to "true". */
export function targetPersonalV1Env():Record<string,"true">{
  return Object.fromEntries(TARGET_PERSONAL_V1_PROFILE.map(name=>[name,"true" as const]));
}
