/** UI-09d: no production navigation, read-only note view. */
import {notFound} from "next/navigation";
import {TargetStagingNotePreview} from "../../../../ui/target-staging-note-preview";
import {validNotePreviewId} from "../../../../../lib/target-staging-note-preview-client";
import "./preview.css";

export const dynamic="force-dynamic";
export const metadata={robots:{index:false,follow:false}};

export default async function TargetStagingNotePreviewPage({
  params,
}:{params:Promise<{noteId:string}>}){
  if([
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_NOTE_CLIENT_PREVIEW_ENABLED",
  ].some(flag=>process.env[flag]!=="true"))notFound();
  const {noteId}=await params;
  if(!validNotePreviewId(noteId))notFound();
  return <TargetStagingNotePreview key={noteId} noteId={noteId}/>;
}
