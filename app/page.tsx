"use client";
import { useLumiApp } from "./ui/use-lumi-app";
import { AuthScreen } from "./ui/views/auth-screen";
import { Sidebar } from "./ui/views/sidebar";
import { Topbar } from "./ui/views/topbar";
import { CalendarView } from "./ui/views/calendar-view";
import { HomeView } from "./ui/views/home-view";
import { WorkNowCard } from "./ui/views/work-now-card";
import { DayPlanCard } from "./ui/views/day-plan-card";
import { SearchResults } from "./ui/views/search-results";
import { ContextView } from "./ui/views/context-view";
import { AgentsView } from "./ui/views/agents-view";
import { SettingsView } from "./ui/views/settings-view";
import { EntityList } from "./ui/views/entity-list";
import { MobileNav } from "./ui/views/mobile-nav";
import { CaptureDialog } from "./ui/views/capture-dialog";
import { DetailPanel } from "./ui/views/detail-panel";
import { AssistantPanel } from "./ui/views/assistant-panel";
import { ConfirmDialog } from "./ui/views/confirm-dialog";
import { HeldBack } from "./ui/views/held-back";

export default function App() {
  const app = useLumiApp();
  const {
    activeWorkspace,
    activeWorkspaceId,
    authState,
    language,
    restore,
    tr,
    undo,
    view,
    workspaceName,
  } = app;
  if (authState !== "ready" && !app.offlineView) {
    return (
      <AuthScreen app={app} />
    );
  }
  return (
    <main className={`appShell view-${view.toLowerCase()}${app.selected ? " inspectorOpen" : ""}`} data-workspace-tone={app.activeWorkspaceTone}>
      <Sidebar app={app} />
      <section className="appPane">
        {app.offlineView && (
          <div className="offlineStart" role="status">
            <p><b>{tr("offlineStartTitle")}</b> {tr("offlineStartDetail")}{app.offlineRetry === "failed" && <> <b>{tr("offlineStillNoConnection")}</b></>}</p>
            <button type="button" disabled={app.offlineRetry === "checking"} onClick={() => void app.retryAccess()}>{tr(app.offlineRetry === "checking" ? "checking" : "retry")}</button>
          </div>
        )}
        {app.restoredNotice && (
          <div className="offlineStart restoredNotice" role="status">
            <p><b>{tr("restoredNoticeTitle")}</b> {tr("restoredNoticeDetail")}</p>
            <button type="button" onClick={app.dismissRestoredNotice}>{tr("restoredNoticeOk")}</button>
          </div>
        )}
        <Topbar app={app} />
        <div className="content">
          <div className="pageIntro">
            {view !== "Home" && (
              <p className="eyebrow">
                {workspaceName.toUpperCase()} · {activeWorkspaceId === "all" ? "AGGREGATE" : String(activeWorkspace?.properties.kind || "PERSONAL").toUpperCase()}
              </p>
            )}
            <div className="pageTitleRow">
              <h1>{tr(view)}</h1>
              {(view === "Today" || view === "Home") && <time>{new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date())}</time>}
            </div>
          </div>
          <HeldBack app={app} />
          <CalendarView app={app} />
          <HomeView app={app} />
          {view === "Today" && <WorkNowCard app={app} />}
          {view === "Today" && <DayPlanCard app={app} />}
          <SearchResults app={app} />
          <ContextView app={app} />
          <AgentsView app={app} />
          <SettingsView app={app} />
          <EntityList app={app} />
        </div>
      </section>
      <MobileNav app={app} />
      <CaptureDialog app={app} />
      <DetailPanel app={app} />
      <AssistantPanel app={app} />
      <ConfirmDialog app={app} />
      {app.signingOutElsewhere && <div className="tabNotice" role="status">{app.tr("signingOutElsewhere")}</div>}
      {undo && (
        <div className="undo">
          {tr("itemChanged")} <button onClick={restore}>{tr("undo")}</button>
        </div>
      )}
    </main>
  );
}
