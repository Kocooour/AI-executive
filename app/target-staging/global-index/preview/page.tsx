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
  // Both the source index and target preview must be independently opted in.
  // This flag only exposes hrefs; it does not grant data or make a detail GET.
  const linkDetails=process.env.AI_EXECUTIVE_TARGET_STAGING_INDEX_DETAIL_LINKS_ENABLED==="true";
  const projectDetailEnabled=linkDetails&&
    process.env.AI_EXECUTIVE_TARGET_STAGING_PROJECT_TASKS_CLIENT_PREVIEW_ENABLED==="true";
  const noteDetailEnabled=linkDetails&&
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED==="true"&&
    process.env.AI_EXECUTIVE_TARGET_STAGING_NOTE_CLIENT_PREVIEW_ENABLED==="true";
  return <TargetStagingGlobalIndexPreview
    projectDetailEnabled={projectDetailEnabled}
    noteDetailEnabled={noteDetailEnabled}/>;
}
