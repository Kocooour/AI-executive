import { LumiAppRoot } from "./ui/lumi-app-root";
import { TargetDataProvider } from "./ui/target-data-provider";
import { targetUiEnabled } from "../lib/target-staging-session-generation";
import { targetDataNeeded, targetUiConfig } from "../lib/target-ui-config";
import {targetMainTitleSearchEnabled} from "../lib/target-main-title-search-ui";
import {targetProjectTitleEditUiEnabled} from "../lib/target-project-title-edit-ui-gate";
import { targetNoteEditUiEnabled } from "../lib/target-note-edit-ui-gate";
import {targetPrivateNoteAreaUiEnabled} from "../lib/target-private-note-area-ui-gate";
import {targetPrivateNoteCreateUiEnabled} from "../lib/target-private-note-create-ui-gate";
import {targetPrivateTaskCreateUiEnabled} from "../lib/target-private-task-create-ui-gate";

// R3-FE-1/2: the flags are read per request. When they are off (default) the app is
// rendered exactly as before: no provider, no runtime, no config, no additional request.
export const dynamic = "force-dynamic";

export default function Page() {
  // The provider (and its session check) mounts only when a target screen is
  // actually enabled; R3-FE-1 alone has no consumer and makes no request.
  const config = targetUiEnabled() ? targetUiConfig(process.env) : null;
  // R3-FE-3: the provider also mounts when a scoped list view is enabled; the
  // switcher flag alone (no My Plan, no list) has no consumer and makes no request. Details open only from a
  // list or the plan, so they are no consumer either.
  const targetSearch=Boolean(config)&&targetMainTitleSearchEnabled(process.env);
  const targetData = targetDataNeeded(config)||targetSearch;
  // H1-real.9: both server-only opt-ins are required to mount the owner-only
  // Context source status; never expose this feature merely because the
  // read-only API was enabled for private operator or staging use.
  const humanWikiSourceStatusEnabled =
    process.env.AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_UI_ENABLED === "true" &&
    process.env.AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_STATUS_ENABLED === "true";
  return targetData
    ? <TargetDataProvider><LumiAppRoot targetMyPlan={config?.myPlan} targetScopes={config?.scopes} targetDetails={config?.details} targetEdits={config?.edits} targetNoteEdit={Boolean(config?.details.note) && targetNoteEditUiEnabled(process.env)} targetProjectEdit={Boolean(config?.details.project) && targetProjectTitleEditUiEnabled(process.env)} targetPrivateNoteAreas={Boolean(config?.scopes.notes)&&targetPrivateNoteAreaUiEnabled(process.env)} targetPrivateNoteCreate={Boolean(config?.scopes.notes)&&targetPrivateNoteCreateUiEnabled(process.env)} targetPrivateTaskCreate={Boolean(config?.scopes.notes&&config?.myPlan.enabled&&config?.details.task)&&targetPrivateTaskCreateUiEnabled(process.env)} targetSearch={targetSearch} humanWikiSourceStatusEnabled={humanWikiSourceStatusEnabled} /></TargetDataProvider>
    : <LumiAppRoot humanWikiSourceStatusEnabled={humanWikiSourceStatusEnabled} />;
}
