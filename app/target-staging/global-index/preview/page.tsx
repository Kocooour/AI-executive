/** UI-09a: default-off global index staging preview; no production UI link. */
import {notFound} from "next/navigation";
import {TargetStagingGlobalIndexPreview} from "../../../ui/target-staging-global-index-preview";
import "./preview.css";

export const dynamic="force-dynamic";
export const metadata={robots:{index:false,follow:false}};

export default function GlobalIndexStagingPreviewPage(){
  if([
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_GLOBAL_INDEX_CLIENT_PREVIEW_ENABLED",
  ].some(flag=>process.env[flag]!=="true"))notFound();
  return <TargetStagingGlobalIndexPreview/>;
}
