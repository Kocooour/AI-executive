/** UI-09f: no production navigation, read-only task view. */
import {notFound} from "next/navigation";
import {TargetStagingTaskPreview} from "../../../../ui/target-staging-task-preview";
import {validTaskPreviewId} from "../../../../../lib/target-staging-task-preview-client";
import "./preview.css";

export const dynamic="force-dynamic";
export const metadata={robots:{index:false,follow:false}};

export default async function TargetStagingTaskPreviewPage({
  params,
}:{params:Promise<{taskId:string}>}){
  if([
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_TASK_CLIENT_PREVIEW_ENABLED",
  ].some(flag=>process.env[flag]!=="true"))notFound();
  const {taskId}=await params;
  if(!validTaskPreviewId(taskId))notFound();
  return <TargetStagingTaskPreview key={taskId} taskId={taskId}/>;
}
