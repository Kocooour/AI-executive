/** UI-09b: isolated title-search preview; no production shell navigation. */
import {notFound} from "next/navigation";
import {TargetStagingTitleSearchPreview} from "../../../ui/target-staging-title-search-preview";
import "./preview.css";

export const dynamic="force-dynamic";
export const metadata={robots:{index:false,follow:false}};

export default function StagingTitleSearchPreviewPage(){
  if([
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_TITLE_SEARCH_CLIENT_PREVIEW_ENABLED",
  ].some(flag=>process.env[flag]!=="true"))notFound();
  return <TargetStagingTitleSearchPreview/>;
}
