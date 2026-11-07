/** UI-09c: isolated project detail preview. No production navigation or cutover. */
import {notFound} from "next/navigation";
import {isReadableStagingProjectId} from "../../../../../lib/target-project-id";
import {TargetStagingProjectTasksPreview} from "../../../../ui/target-staging-project-tasks-preview";
import "./preview.css";

export const dynamic="force-dynamic";
export const metadata={robots:{index:false,follow:false}};
export default async function ProjectTasksPreviewPage({
  params,
}:{params:Promise<{projectId:string}>}){
  if(process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_PROJECT_TASKS_CLIENT_PREVIEW_ENABLED!=="true")
    notFound();
  const {projectId}=await params;
  if(!isReadableStagingProjectId(projectId))notFound();
  return <TargetStagingProjectTasksPreview projectId={projectId}/>;
}
