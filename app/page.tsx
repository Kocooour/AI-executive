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

export default function App() {
  const app = useLumiApp();
  const {
    activeWorkspace,
    activeWorkspaceId,
    authState,
    homeGreeting,
    language,
    restore,
    tr,
    undo,
    view,
    workspaceName,
  } = app;
  if (authState !== "ready") {
    return (
      <AuthScreen app={app} />
    );
  }
  return (
    <main className={`appShell view-${view.toLowerCase()}`}>
      <Sidebar app={app} />
      <section className="appPane">
        <Topbar app={app} />
        <div className="content">
          <div className="pageIntro">
            <p className="eyebrow">
              {workspaceName.toUpperCase()} · {activeWorkspaceId === "all" ? "AGGREGATE" : String(activeWorkspace?.properties.kind || "PERSONAL").toUpperCase()}
            </p>
            <div className="pageTitleRow">
              <h1>{view === "Home" ? homeGreeting : tr(view)}</h1>
              {view === "Today" && <time>{new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date())}</time>}
            </div>
            {view === "Home" && <p className="pageSubtitle">{tr("homeSubtitle")}</p>}
          </div>
          <CalendarView app={app} />
          <HomeView app={app} />
          <WorkNowCard app={app} />
          <DayPlanCard app={app} />
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
      {undo && (
        <div className="undo">
          {tr("itemChanged")} <button onClick={restore}>{tr("undo")}</button>
        </div>
      )}
    </main>
  );
}
