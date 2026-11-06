/** R3-slice/UI-03b: independent SERVER-side opt-in for rendering write UI.
 * This is NOT an authorization check; staging status HTTP enforces its own
 * session, Origin, scope, Area ACL, CAS and restore barriers per request. */
export const MY_PLAN_STATUS_UI_WRITE_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_STATUS_UI_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED",
] as const;

export function myPlanStagingWriteUiEnabled(
  env:Record<string,string|undefined>,
):boolean{
  return MY_PLAN_STATUS_UI_WRITE_FLAGS.every(name=>env[name]==="true");
}
