/** No navigation entry or production runtime integration. Server-side
 * feature gate hides this staging-only read preview by default. */
import {notFound} from "next/navigation";
import {TargetStagingMyPlanPreview} from "../../../ui/target-staging-my-plan-preview";
import "./preview.css";

export const dynamic="force-dynamic";
export const metadata={robots:{index:false,follow:false}};

export default function StagingMyPlanPreviewPage(){
  if([
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_CLIENT_PREVIEW_ENABLED",
  ].some(name=>process.env[name]!=="true"))notFound();
  // UI write affordances require a separate opt-in on this SERVER render.
  // This is NOT authorization: the status endpoints independently enforce all
  // four write flags, current session, Area ACL and optimistic CAS.
  const statusWriteEnabled=[
    "AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_STATUS_UI_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED",
  ].every(name=>process.env[name]==="true");
  return <TargetStagingMyPlanPreview statusWriteEnabled={statusWriteEnabled}/>;
}
