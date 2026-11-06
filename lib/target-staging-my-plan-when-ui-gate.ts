/** R3 UI-04b: independent server-only opt-in for actor-private "Kdy" controls.
 * Rendering permission is NOT an ACL grant. Every request is still authorized
 * by the staging personal-when endpoint and pinned write transaction. */
export const MY_PLAN_WHEN_UI_WRITE_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_WHEN_UI_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED",
] as const;

export function myPlanStagingWhenUiEnabled(
  env:Record<string,string|undefined>,
):boolean{
  return MY_PLAN_WHEN_UI_WRITE_FLAGS.every(name=>env[name]==="true");
}
