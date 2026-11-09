"use client";
import dynamic from "next/dynamic";
import { useLumiApp } from "./use-lumi-app";
import { mobileDesignV1Preview } from "./navigation";
import { projectSyncNoticeLabel } from "../../lib/project-sync-notice";
import { AuthScreen } from "./views/auth-screen";
import { Sidebar } from "./views/sidebar";
import { Topbar } from "./views/topbar";
import { CalendarView } from "./views/calendar-view";
import { HomeView } from "./views/home-view";
import { TodayFooter, TodayHeaderMeta, TodayTop } from "./views/today-view";
import { SearchResults } from "./views/search-results";
import { ContextView } from "./views/context-view";
import { AgentsView } from "./views/agents-view";
import { SettingsView } from "./views/settings-view";
import { EntityList } from "./views/entity-list";
import { MobileNav } from "./views/mobile-nav";
import { DesktopCaptureFab } from "./views/desktop-capture-fab";
import { CaptureDialog } from "./views/capture-dialog";
import { DetailPanel } from "./views/detail-panel";
import { AssistantPanel } from "./views/assistant-panel";
import { ConfirmDialog } from "./views/confirm-dialog";
import { DeferPopover } from "./views/defer-popover";
import { HeldBack } from "./views/held-back";
import { OfflineRecoveryDialog } from "./views/offline-recovery-dialog";

// R3-FE-2: loaded (with its CSS) only when the server page enabled the target My Plan.
const TargetMyPlan = dynamic(() => import("./target-my-plan"), { ssr: false });

// R3-FE-3: the scope switcher and the server-backed Projects / Notes lists load only
// when the server page enabled target scopes; otherwise they are never fetched.
const TargetScopeSwitcher = dynamic(() => import("./target-scope-switcher"), { ssr: false });
const TargetScopeLists = dynamic(() => import("./target-scope-lists"), { ssr: false });

export type TargetScopesProps = { enabled: boolean; projects: boolean; notes: boolean };
export type TargetMyPlanProps = { enabled: boolean; statusWrite: boolean; whenWrite: boolean };

export function LumiAppRoot({ targetMyPlan, targetScopes }: { targetMyPlan?: TargetMyPlanProps; targetScopes?: TargetScopesProps } = {}) {
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
  // Only the "Můj plán" entry of the v1 shell (view "Today") switches; every other view stays legacy.
  const targetPlan = Boolean(targetMyPlan?.enabled) && mobileDesignV1Preview && app.mobilePlanPreviewActive && view === "Today";
  // R3-FE-3: with target scopes on, Projects and Notes list the server index for the global scope.
  const scopesOn = Boolean(targetScopes?.enabled);
  // Per view: a view without its own flag keeps the legacy list.
  const scopeList = scopesOn && view === "Projects" && targetScopes?.projects ? "project"
    : scopesOn && view === "Notes" && targetScopes?.notes ? "note" : null;
  const scopeSwitcher = scopeList !== null || (scopesOn && targetPlan);
  return (
    <main className={`appShell view-${view.toLowerCase()}${app.selected ? " inspectorOpen" : ""}${view === "Projects" && app.openProject ? " projectPageOpen" : ""}`} data-design-system={mobileDesignV1Preview ? "lumi-v1" : undefined} data-workspace-tone={app.activeWorkspaceTone}
      data-my-plan-preview={mobileDesignV1Preview && app.mobilePlanPreviewActive && view === "Today" ? "true" : undefined}>
      <Sidebar app={app} targetPlan={Boolean(targetMyPlan?.enabled)} />
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
        {mobileDesignV1Preview && app.projectSyncNotices.map((notice) => (
          <div key={notice.projectId} className="navigationUnavailableNotice" role="alert"
            data-testid="project-sync-warning">
            <p><strong>{projectSyncNoticeLabel(notice, app.projectSyncNotices, language)}</strong>: {language === "cs"
              ? (notice.kind === "delete"
                ? "Projekt byl odstraněn v tomto zařízení, ale server zatím nepotvrdil smazání. Změna může čekat na synchronizaci; zkontrolujte připojení."
                : "Stav projektu byl změněn v tomto zařízení, ale server zatím nepotvrdil uložení. Změna může čekat na synchronizaci; zkontrolujte připojení.")
              : (notice.kind === "delete"
                ? "The project was deleted on this device, but the server has not confirmed the deletion. The change may be pending sync; check your connection."
                : "The project status changed on this device, but the server has not confirmed the save. The change may be pending sync; check your connection.")}</p>
            <button type="button"
              aria-label={language === "cs"
                ? `Skrýt upozornění projektu ${projectSyncNoticeLabel(notice, app.projectSyncNotices, language)}`
                : `Dismiss notice for project ${projectSyncNoticeLabel(notice, app.projectSyncNotices, language)}`}
              onClick={() => app.dismissProjectSyncNotice(notice.projectId)}>
              {language === "cs" ? "Skrýt upozornění" : "Dismiss notice"}
            </button>
          </div>
        ))}
        {app.navigationUnavailable && !scopeList && (
          <div className="navigationUnavailableNotice" role="status" data-testid="navigation-unavailable">
            <p>{language === "cs"
              ? "Odkaz nelze otevřít. Položka není v aktuálních datech dostupná."
              : "This link cannot be opened. The item is not available in the current data."}</p>
            <button type="button" onClick={app.dismissNavigationUnavailable}>
              {language === "cs" ? "Skrýt upozornění" : "Dismiss notice"}
            </button>
          </div>
        )}
        {targetPlan && (
          <p className="mobileV1PreviewNotice" role="status" data-plan-source="target-staging">
            {language === "cs"
              ? "Zobrazený plán je serverový plán ze stagingu: vaše soukromé úkoly a sdílené úkoly přiřazené vám. Dosavadní místní seznam Dnes se zde nepoužívá."
              : "This plan comes from the staging server: your private tasks and the shared tasks assigned to you. The existing local Today list is not used here."}
          </p>
        )}
        {!targetPlan && mobileDesignV1Preview && app.mobilePlanPreviewActive && view === "Today" && (
          <p className="mobileV1PreviewNotice" role="status" data-plan-source="legacy-today">
            {language === "cs"
              ? "Vývojový náhled Mého plánu: nyní zobrazuje dosavadní seznam Dnes v aktivním prostoru, nikoli cílový autorizovaný Můj plán."
              : "My Plan development preview: this is the existing Today list in the current workspace, not the authorized target My Plan."}
          </p>
        )}
        <div className="content">
          <div className="pageIntro">
            {view !== "Home" && (
              <p className="eyebrow">
                {workspaceName.toUpperCase()} · {activeWorkspaceId === "all" ? "AGGREGATE" : String(activeWorkspace?.properties.kind || "PERSONAL").toUpperCase()}
              </p>
            )}
            <div className="pageTitleRow">
              <h1 tabIndex={mobileDesignV1Preview ? -1 : undefined}>{mobileDesignV1Preview && app.mobilePlanPreviewActive && view === "Today"
                ? (language === "cs" ? "Můj plán" : "My Plan") : tr(view)}</h1>
              {(view === "Today" || view === "Home") && <time>{new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date())}</time>}
              {view === "Today" && !targetPlan && <TodayHeaderMeta app={app} />}
            </div>
          </div>
          {scopeSwitcher && <TargetScopeSwitcher language={language} variant={scopeList === null ? "plan" : "lists"} />}
          <HeldBack app={app} />
          <CalendarView app={app} />
          <HomeView app={app} />
          {view === "Today" && !targetPlan && <TodayTop app={app} />}
          <SearchResults app={app} />
          <ContextView app={app} />
          <AgentsView app={app} />
          <SettingsView app={app} />
          {targetPlan && targetMyPlan
            ? <TargetMyPlan gates={targetMyPlan} language={language} scopeDriven={scopesOn} />
            : scopeList
              ? <TargetScopeLists key={scopeList} kind={scopeList} language={language} />
              : <EntityList app={app} />}
          {view === "Today" && !targetPlan && <TodayFooter app={app} />}
        </div>
      </section>
      <MobileNav app={app} targetPlan={Boolean(targetMyPlan?.enabled)} />
      <DesktopCaptureFab app={app} />
      <CaptureDialog app={app} />
      <DetailPanel app={app} />
      <AssistantPanel app={app} />
      <DeferPopover app={app} />
      <ConfirmDialog app={app} />
      <OfflineRecoveryDialog app={app} />
      {app.signingOutElsewhere && <div className="tabNotice" role="status">{app.tr("signingOutElsewhere")}</div>}
      {undo && (
        <div className="undo">
          {tr("itemChanged")} <button onClick={restore}>{tr("undo")}</button>
        </div>
      )}
    </main>
  );
}
