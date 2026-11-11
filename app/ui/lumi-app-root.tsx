"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { TargetSidebarContext } from "./target-sidebar-context";
import { LegacyWritesContext } from "./legacy-writes-context";
import { useLumiApp } from "./use-lumi-app";
import { expectFocusReturn, focusPendingRow, useTargetSearch } from "./target-detail-state";
import { detailActivation, detailRouteKey, isParentOf, isTargetAddress, viewOfSearch, type DetailActivation } from "../../lib/target-detail-route";
import { activeTargetViewFor, detailsActive, targetViewsFor } from "../../lib/target-shell-views";
import { detailCopy } from "../../lib/target-detail-copy";
import type { TargetUiEdits } from "../../lib/target-ui-config";
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

// R3-FE-4a: authorized details inside the main app; loaded only when a detail flag is on.
const TargetDetailPanel = dynamic(() => import("./target-detail-panel"), { ssr: false });
// R3-CAPTURE-1: read-only, real actor-private Area catalogue in target Notes.
const TargetPrivateNoteAreaChooser = dynamic(() => import("./target-private-note-area-chooser"), { ssr: false });

export type TargetDetailsProps = { task: boolean; project: boolean; note: boolean };
export type TargetScopesProps = { enabled: boolean; projects: boolean; notes: boolean };
export type TargetEditsProps = TargetUiEdits;
export type TargetMyPlanProps = { enabled: boolean; statusWrite: boolean; whenWrite: boolean };

export function LumiAppRoot({ targetMyPlan, targetScopes, targetDetails, targetEdits, targetNoteEdit = false, targetPrivateNoteAreas = false, targetPrivateNoteCreate = false }: { targetMyPlan?: TargetMyPlanProps; targetScopes?: TargetScopesProps; targetDetails?: TargetDetailsProps; targetEdits?: TargetEditsProps; targetNoteEdit?: boolean; targetPrivateNoteAreas?: boolean; targetPrivateNoteCreate?: boolean } = {}) {
  // Owner decision 2026-11-09: with target scopes on, the single global scope governs the
  // sidebar projects, the inspector and quick capture (see docs/R3-FE-04A-DETAILS.md).
  const scopesOn = Boolean(targetScopes?.enabled);
  const [areaChooserOpen,setAreaChooserOpen]=useState(false);
  const [noteListRevision,setNoteListRevision]=useState(0);
  const detailGates = { task: Boolean(targetDetails?.task), project: Boolean(targetDetails?.project), note: Boolean(targetDetails?.note) };
  const shellInput = { scopesOn, projectsList: Boolean(targetScopes?.projects), notesList: Boolean(targetScopes?.notes),
    myPlan: Boolean(targetMyPlan?.enabled), v1Shell: mobileDesignV1Preview };
  // Details act only on views that really render target data (never on legacy views).
  const targetViews = targetViewsFor(shellInput);
  const detailsOn = detailsActive(detailGates, targetViews);
  const app = useLumiApp({ targetDetails: detailsOn, targetUnified: scopesOn, targetViews: detailsOn ? targetViews : [] });
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
  const planActive = mobileDesignV1Preview && app.mobilePlanPreviewActive && view === "Today";
  const { scopeList, targetPlan, active: activeTargetView } = activeTargetViewFor({ ...shellInput, view, planActive });
  // Never keep the chooser active when leaving the target Notes view.
  useEffect(()=>{setAreaChooserOpen(false);},[view,scopesOn,targetPrivateNoteAreas]);
  const detailSearch = useTargetSearch(detailsOn);
  const activation: DetailActivation = detailsOn
    ? detailActivation({ search: detailSearch, gates: detailGates, activeTargetView }) : { state: "none" };
  const detailRoute = activation.state === "route" ? activation.route : null;
  const detailKey = detailRoute !== null ? detailRouteKey(detailRoute) : activation.state;
  // After a detail closed (Close, Back, Forward), focus returns to the row that opened it;
  // opening a deeper detail (project -> its task) never returns focus to the list.
  const previousRoute = useRef<typeof detailRoute>(null);
  useEffect(() => {
    if (!detailsOn) return;
    const previous = previousRoute.current;
    previousRoute.current = detailRoute;
    if (previous !== null && !isParentOf(previous, detailRoute)) expectFocusReturn(previous);
    const frame = window.requestAnimationFrame(() => {
      // A successful refresh can also remove the originating row (e.g. revoked
      // access). When the detail has fully closed, offer its list status as a
      // neutral fallback regardless of ready/loading/error; the row wins if
      // still present. Do not consume a pending nested-detail return here.
      const listStatus = activation.state === "none"
        ? document.querySelector<HTMLElement>(".targetScopeList .targetScopeStatus")
        : null;
      focusPendingRow(listStatus ?? document.querySelector<HTMLElement>(".appPane .pageTitleRow h1"), Boolean(listStatus));
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsOn, detailKey]);
  // A legitimate typed link to ANOTHER active target view (e.g. ?view=Notes&noteId=... while Projects is
  // shown) switches the shell to that view and opens it; the address is kept (never rewritten).
  useEffect(() => {
    if (!detailsOn || !isTargetAddress(detailSearch, targetViews)) return;
    const wanted = viewOfSearch(detailSearch);
    if (wanted === null || wanted === activeTargetView) return;
    if (wanted === "MyPlanPreview") app.setView("Today", { previewMyPlan: true, keepAddress: true });
    else app.setView(wanted, { keepAddress: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsOn, detailSearch, activeTargetView]);
  if (authState !== "ready" && !app.offlineView) {
    return (
      <AuthScreen app={app} />
    );
  }
  const scopeSwitcher = scopeList !== null || (scopesOn && targetPlan);
  const detailPanel = detailsOn && activation.state !== "none";
  // The legacy inspector is never fed legacy records in a target view.
  const targetView = scopeList !== null || targetPlan;
  const legacyInspector = Boolean(app.selected) && !(scopesOn && targetView);
  // Unified target mode: views that still show legacy data are read-only (no target create/edit API yet).
  const legacyReadOnly = app.legacyWritesDisabled && !targetView;
  return (
    <LegacyWritesContext.Provider value={{ disabled: app.legacyWritesDisabled, hint: app.legacyReadOnlyHint }}>
    <main className={`appShell view-${view.toLowerCase()}${legacyInspector || detailPanel ? " inspectorOpen" : ""}${view === "Projects" && app.openProject ? " projectPageOpen" : ""}`} data-design-system={mobileDesignV1Preview ? "lumi-v1" : undefined} data-workspace-tone={app.activeWorkspaceTone}
      data-my-plan-preview={mobileDesignV1Preview && app.mobilePlanPreviewActive && view === "Today" ? "true" : undefined}>
      <TargetSidebarContext.Provider value={scopesOn && targetScopes?.projects ? { projects: true, openable: detailsOn && detailGates.project } : undefined}>
        <Sidebar app={app} targetPlan={Boolean(targetMyPlan?.enabled)} />
      </TargetSidebarContext.Provider>
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
          {legacyReadOnly && (
            <p className="navigationUnavailableNotice legacyReadOnlyNotice" role="status" data-testid="legacy-read-only-notice">
              {detailCopy[language].legacyReadOnlyNotice}
            </p>
          )}
          {app.legacyWritesDisabled && app.legacyWriteAttempt && (
            <div className="navigationUnavailableNotice legacyReadOnlyNotice" role="alert" data-testid="legacy-write-blocked">
              <p>{detailCopy[language].legacyWriteBlocked}</p>
              <button type="button" onClick={app.dismissLegacyWriteAttempt}>{detailCopy[language].dismiss}</button>
            </div>
          )}
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
          {scopeList==="note"&&targetPrivateNoteAreas&&<button type="button"
            className="targetScopeAreaChooserButton" data-testid="target-private-area-open"
            onClick={()=>setAreaChooserOpen(true)}>{targetPrivateNoteCreate
              ?(language==="cs"?"Nová soukromá poznámka":"New private note")
              :(language==="cs"?"Oblasti pro novou poznámku":"Areas for a new note")}</button>}
          <HeldBack app={app} />
          <CalendarView app={app} />
          <HomeView app={app} />
          {view === "Today" && !targetPlan && <TodayTop app={app} />}
          <SearchResults app={app} />
          <ContextView app={app} />
          <AgentsView app={app} />
          <SettingsView app={app} />
          {targetPlan && targetMyPlan
            ? <TargetMyPlan gates={targetMyPlan} language={language} scopeDriven={scopesOn} taskDetail={detailGates.task} />
            : scopeList
              ? <TargetScopeLists key={scopeList==="note"?scopeList+":"+noteListRevision:scopeList} kind={scopeList} language={language}
                detail={scopeList === "project" ? detailGates.project : detailGates.note} />
              : <EntityList app={app} />}
          {view === "Today" && !targetPlan && <TodayFooter app={app} />}
        </div>
      </section>
      <MobileNav app={app} targetPlan={Boolean(targetMyPlan?.enabled)} />
      <DesktopCaptureFab app={app} />
      <CaptureDialog app={app} />
      {scopeList==="note"&&targetPrivateNoteAreas&&areaChooserOpen&&
        <TargetPrivateNoteAreaChooser language={language} createEnabled={targetPrivateNoteCreate}
          onClose={()=>setAreaChooserOpen(false)} onCreated={()=>{
            setAreaChooserOpen(false);setNoteListRevision(v=>v+1);
          }} />}
      {!(scopesOn && targetView) && <DetailPanel app={app} />}
      {detailPanel && <TargetDetailPanel route={detailRoute} language={language} gates={detailGates} edits={targetEdits} noteEdit={targetNoteEdit && detailGates.note} />}
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
    </LegacyWritesContext.Provider>
  );
}
