"use client";
import { type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isFallbackArea } from "../../lib/area-write-invariants";
import { captureDestinationKey, captureNeedsShareConsent, initialCaptureWorkspace } from "../../lib/capture-destination";
import { areaKindOf, assignFallbackArea, dropTaskAreaLinks, taskIsInProject } from "../../lib/area-write-client";
import { db, ensureDefaultWorkspace, migratePropertyRelations, personalWorkspaceId, readLocalWithBase, replaceSyncBase, seed, type Entity, type EntityType, type Relation } from "../../lib/db";
import { clearLocalData, finishInterruptedWipe, hasUnsentChanges, markSignedIn, restoreGenerationKey, signedInKey, signedOutKey } from "../../lib/local-data";
import { failedSignOutNeedsReload, incompleteSignOutNoticeKey, runSignOut } from "../../lib/sign-out";
import { dropNotesDraft, keepNotesDraft, keptNotesDrafts, leftoverDraftAction, settleNotesDraft, type KeptNotesDraft } from "../../lib/notes-drafts";
import { addressUpdate, scopeFromSearch, searchForTarget, searchForView, searchWithScope, searchWithoutScope, targetFromSearch, viewExitFromProject, viewFromSearch } from "../../lib/view-url";
import { resolveLegacyProjectLink } from "../../lib/legacy-project-deep-link";
import { requestsTypedRecord, showUnavailableLink } from "../../lib/navigation-link-status";
import { detailCopy } from "../../lib/target-detail-copy";
import { TARGET_ADDRESS_EVENT, holdTypedAddress, isPlanDetailSearch, isTargetAddress, shouldLeaveTypedAddress } from "../../lib/target-detail-route";
import { legacyRecordBelongsToProject, resolveLegacyRecordLink } from "../../lib/legacy-record-deep-link";
import { buildContext, type ContextBundle } from "../../lib/context";
import { mergeSnapshots, type ServerSnapshot } from "../../lib/server-sync";
import { isAdopting, takeAfterRestoreFlag } from "../../lib/adoption";
import { offlineRecoveryIsHeld, offlineRecoveryWipeSupported } from "../../lib/d2b-recovery-hold";
import { recordDeleted, recordRevived } from "../../lib/pending-markers";
import { writeTime } from "../../lib/clock";
import { otherOpenTexts, renewOpenTexts, setOpenTexts, type OpenTextKind } from "../../lib/open-texts";
import { forServer, isSendable } from "../../lib/sendable";
import { askOtherTabsToSave, postToTabs, tabChannelName, type TabMessage } from "../../lib/tab-coordination";
import { conflictsKey, entityConflicts, placementFields } from "../../lib/field-merge";
import { fetchClientAuthStatus } from "../../lib/client-auth-status";
import { addLocalDays, fromLocalDateTime, toLocalDateTime, ymd, zonedDateTimeToIso } from "../../lib/local-dates";
import { addCalendarDays, calendarEventOverlapsLocalRange, calendarLocalDayRange } from "../../lib/calendar-event-display";
import { deferTargets } from "../../lib/defer-suggestion";
import { todayProposalTaskSignature } from "../../lib/today-summary";
import { homeTodayList } from "../../lib/home-today";
import { groupProjectsByArea, projectsNeedAttention, activeSidebarProjects } from "../../lib/project-navigation";
import { projectAcceptsNewItems } from "../../lib/project-summary";
import { projectPreviewCanCommit, projectPreviewDependents, waitForProjectPreviewWrites, type ProjectPreviewActionSnapshot } from "../../lib/project-list-preview";
import { projectSyncNoticeResolved, projectSyncNoticesAfterUndo, withProjectSyncNotice, withoutProjectSyncNotice,
  withoutResolvedProjectSyncNotices, type ProjectSyncNotice, type ProjectSyncNotices } from "../../lib/project-sync-notice";
import { knownProjectFocusPosition, projectFocusReturnForHistory, shouldRestoreProjectFocus,
  type ProjectFocusEntry } from "../../lib/project-return-focus";
import { byManualOrder, isEveningTask, manualOrder, newTaskPlacement, parseCaptureText, taskDateSortKey, taskMatchesView } from "../../lib/task-views";
import { buildMyPlanPreview, previewManualRankUpdates, previewRankNextRecords, previewRankWritesAllowed, previewReorderPeers } from "../../lib/my-plan-preview";
import { inSentenceDate } from "./format";
import { findActiveProjectWithTitle } from "../../lib/project-title";
import { type AIProposal, type AssistantMessage, type CalendarEvent, type CalendarSourceState, type CaptureProjectAction, type CaptureSuggestion, type ConfirmRequest, type ContextClaimItem, type ContextHistoryState, type ContextHistoryStep, type ContextInboxProposal, type ContextInboxTaskDraft, type DayPlanItem, type DurableContextItem, type Language, type NotificationState, type PACTAgentResult, type PACTAgentRunSummary, type PACTAgentSummary, type StandaloneSubjectItem, type ThemeMode } from "./types";
import { copy } from "./copy";
import { mobileDesignV1Preview, mobileV1IsPlanPreviewRoute, views } from "./navigation";
import { mobileMoreExitFocus, mobileMoreHeadingRevealDelta } from "../../lib/mobile-more-focus";
import { useAttention } from "./hooks/use-attention";
import { eventTaskSpan } from "../../lib/calendar-decisions";
import { restoreCalendarDecisions, useCalendarEvents, type CalendarDecisionUndo } from "./hooks/use-calendar-events";
import { useDayPlan } from "./hooks/use-day-plan";
import { useContextEvidence } from "./hooks/use-context-evidence";
import { getRelationDefinition, relationsBetween } from "../../lib/context-relations";
import { useBackups } from "./hooks/use-backups";
import { usePasskeys } from "./hooks/use-passkeys";
import { useSignIn } from "./hooks/use-sign-in";
import { useNotifications } from "./hooks/use-notifications";
import { useAppBadge } from "./hooks/use-app-badge";
import { useSync } from "./hooks/use-sync";
import { localizeServerError } from "../../lib/server-errors";
import { workspaceTone } from "./workspace-tone";

// All client state, effects and handlers of the Lumi app shell, moved verbatim from app/page.tsx.
// Views receive the returned object as `app` and destructure what they render.
export function useLumiApp(options: { targetDetails?: boolean; targetUnified?: boolean; targetViews?: readonly string[] } = {}) {
  // R3-FE-4a: both default to false, and then none of the branches below run (legacy
  // behaviour is untouched). targetDetails: a typed project/task/note address is an
  // authorized target detail, resolved by the server, never by legacy local records.
  // targetUnified: the global reading scope governs sidebar projects, inspector and
  // capture, so legacy quick capture writes nothing (there is no target create API yet).
  const targetDetailsRef = useRef(Boolean(options.targetDetails));
  targetDetailsRef.current = Boolean(options.targetDetails);
  // Views that really render target data (target Projects / Notes lists, target My Plan). Typed
  // addresses of any other view keep their exact legacy behaviour.
  const targetViewsRef = useRef<readonly string[]>(options.targetViews ?? []);
  targetViewsRef.current = options.targetViews ?? [];
  const targetTypedNow = () => targetDetailsRef.current && isTargetAddress(window.location.search, targetViewsRef.current);
  const captureDisabled = Boolean(options.targetUnified);
  const captureDisabledRef = useRef(captureDisabled);
  captureDisabledRef.current = captureDisabled;
  // A user tried to change legacy data in unified mode: nothing is written, nothing reports success,
  // and the shell says so (calm alert) instead of a silent no-op.
  const [legacyWriteAttempt, setLegacyWriteAttempt] = useState(false);
  const blockLegacyWrite = () => {
    if (!captureDisabledRef.current) return false;
    setLegacyWriteAttempt(true);
    return true;
  };
  // In-memory only: tasks can navigate to a Gmail source without putting
  // message IDs into URLs, localStorage or persisted navigation state.
  const [mailSourceToOpen, setMailSourceToOpen] = useState<{ workspaceId: string; accountId: string; messageId: string } | null>(null);
  // The Inbox shows tasks or connected Gmail. Its active tab and message IDs are
  // in-memory only; navigation URLs never expose a mail message ID.
  const [inboxTab, setInboxTab] = useState<"tasks" | "mail">("tasks");
  // UI-03f: the presentation-only My Plan route is shared by mobile and
  // desktop v1 preview. Never claim target-model data permissions.
  const [mobilePlanPreviewActive, setMobilePlanPreviewActive] = useState(false);
  const [view, setViewState] = useState("Home"),
    // The project page is resolved from the authorized current scope; the URL carries only its opaque ID.
    [openProjectId, setOpenProjectId] = useState<string | null>(null),
    [navigationUnavailable, setNavigationUnavailable] = useState(false),
    // Independent pending warnings survive other projects' failures, Undo and page unmount.
    [projectSyncNotices, setProjectSyncNotices] = useState<ProjectSyncNotices>({}),
    [text, setText] = useState(""),
    [rowError, setRowError] = useState(false),
    // Only the opt-in Můj plán reorder displays this; never silently treat a
    // rejected multi-record write as a successful move.
    [planReorderError, setPlanReorderError] = useState(false),
    [selected, setSelected] = useState<Entity | null>(null),
    // B5 selections belong to exactly one workspace and never survive a navigation
    // or authentication change. IDs are re-filtered against live Inbox rows below.
    [batchSelection, setBatchSelection] = useState<{ workspaceId: string; ids: string[] }>({ workspaceId: "", ids: [] }),
    [notesDraft, setNotesDraft] = useState<{ id: string; text: string } | null>(null),
    // The body of the open note while it is being typed, and the note whose last save failed locally.
    // `base`: the note text the draft was started from, kept in memory too so the conflict check does not depend on storage.
    [noteBodyDraft, setNoteBodyDraft] = useState<{ id: string; text: string; base: string } | null>(null),
    [noteBodyError, setNoteBodyError] = useState<string | null>(null),
    // The note whose unsaved text started from text that has since been changed elsewhere: nothing is
    // saved over the newer text until the owner chooses.
    [noteBodyConflict, setNoteBodyConflict] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [capture, setCapture] = useState(false),
    [captureType, setCaptureType] = useState<"task" | "note">("task"),
    [captureProjectId, setCaptureProjectId] = useState(""),
    [captureAreaId, setCaptureAreaId] = useState(""),
    [captureWriteWorkspaceId, setCaptureWriteWorkspaceId] = useState(personalWorkspaceId),
    [captureSharedConsentKey, setCaptureSharedConsentKey] = useState(""),
    [draft, setDraft] = useState(""),
    [captureSuggestion, setCaptureSuggestion] = useState<CaptureSuggestion | null>(null),
    [captureSuggestionBusy, setCaptureSuggestionBusy] = useState(false),
    [captureSuggestionError, setCaptureSuggestionError] = useState(""),
    [useCaptureSuggestion, setUseCaptureSuggestion] = useState(true),
    [captureProjectAction, setCaptureProjectAction] = useState<CaptureProjectAction>("none"),
    [undo, setUndo] = useState<Entity | null>(null),
    // The task whose "When" popover is open and the control it hangs from (one popover for the whole app).
    [deferOpen, setDeferOpen] = useState<{ taskId: string; anchor: HTMLElement; origin?: "attention"; attention?: { key: string; fingerprint: string; workspaceId: string; evaluatedAt: number } } | null>(null),
    [deferBusy, setDeferBusy] = useState(false),
    [deferError, setDeferError] = useState(false),
    [undoRelations, setUndoRelations] = useState<Relation[]>([]),
    [context, setContext] = useState<ContextBundle | null>(null),
    [assistantOpen, setAssistantOpen] = useState(false),
    [moreOpen, setMoreOpen] = useState(false),
    [startupView, setStartupView] = useState("Home"),
    [workspaceDraft, setWorkspaceDraft] = useState("Personal"),
    [newWorkspaceDraft, setNewWorkspaceDraft] = useState(""),
    [activeWorkspaceId, setActiveWorkspaceId] = useState("personal"),
    [writeWorkspaceId, setWriteWorkspaceId] = useState("personal"),
    [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false),
    [settingsSaved, setSettingsSaved] = useState(false),
    [settingsSection, setSettingsSection] = useState("general"),
    [language, setLanguage] = useState<Language>("cs"),
    [themeMode, setThemeMode] = useState<ThemeMode>("system"),
    [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light"),
    [themeReady, setThemeReady] = useState(false),
    [standalone, setStandalone] = useState(false),
    [badgeNow, setBadgeNow] = useState(() => Date.now()),
    [addressReady, setAddressReady] = useState(false),
    [deepLinkDone, setDeepLinkDone] = useState(false),
    [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null),
    [logoutBusy, setLogoutBusy] = useState(false),
    // Another tab of this browser is signing out; editing here waits.
    [signingOutElsewhere, setSigningOutElsewhere] = useState(false),
    [logoutError, setLogoutError] = useState(""),
    [pactAgents, setPactAgents] = useState<PACTAgentSummary[]>([]),
    [agentRuns, setAgentRuns] = useState<PACTAgentRunSummary[]>([]),
    [agentResult, setAgentResult] = useState<PACTAgentResult | null>(null),
    [agentBusyId, setAgentBusyId] = useState(""),
    [agentStatus, setAgentStatus] = useState(""),
    [calendarSources, setCalendarSources] = useState<CalendarSourceState[]>([]),
    [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]),
    [calendarFreshNow, setCalendarFreshNow] = useState(() => Date.now()),
    [calendarLabel, setCalendarLabel] = useState("Outlook calendar"),
    [calendarUrl, setCalendarUrl] = useState(""),
    [calendarBusy, setCalendarBusy] = useState(false),
    [calendarStatus, setCalendarStatus] = useState(""),
    // Only current-scope, accepted reads mark a successful Calendar refresh;
    // a stale/ignored response must never clear a newer request's error.
    [calendarLoadSucceededVersion, setCalendarLoadSucceededVersion] = useState(0),
    [durableContext, setDurableContext] = useState<DurableContextItem[]>([]),
    [contextScope, setContextScope] = useState<DurableContextItem["scope"]>("me"),
    [contextSensitivity, setContextSensitivity] = useState<DurableContextItem["sensitivity"]>("normal"),
    [contextTitle, setContextTitle] = useState(""),
    [contextContent, setContextContent] = useState(""),
    [contextProjectId, setContextProjectId] = useState(""),
    [contextStatus, setContextStatus] = useState(""),
    [contextBusy, setContextBusy] = useState(false),
    [contextClaims, setContextClaims] = useState<ContextClaimItem[]>([]),
    [claimHistory, setClaimHistory] = useState<Record<string, Array<{ operation: string; kind?: string; reviewStatus?: string | null; beforeRevision: number | null; afterRevision: number; createdAt: number; decision?: string | null }>>>({}),
    [standaloneSubjects, setStandaloneSubjects] = useState<StandaloneSubjectItem[]>([]),
    [subjectSearch, setSubjectSearch] = useState(""),
    [newSubjectTitle, setNewSubjectTitle] = useState(""),
    [newSubjectType, setNewSubjectType] = useState<"person" | "organization">("person"),
    [subjectBusy, setSubjectBusy] = useState(false),
    [subjectStatus, setSubjectStatus] = useState(""),
    [subjectEditId, setSubjectEditId] = useState(""),
    [subjectEditTitle, setSubjectEditTitle] = useState(""),
    [subjectHistory, setSubjectHistory] = useState<Record<string, Array<{ operation: string; kind?: string; beforeRevision: number | null; afterRevision: number; beforeTitle: string | null; afterTitle: string | null; createdAt: number }>>>({}),
    [claimFilterId, setClaimFilterId] = useState("all"),
    [claimSubjectId, setClaimSubjectId] = useState(""),
    [claimPredicate, setClaimPredicate] = useState("preference"),
    [claimValue, setClaimValue] = useState(""),
    [claimValueType, setClaimValueType] = useState<"string" | "number" | "boolean" | "date">("string"),
    [claimValueMode, setClaimValueMode] = useState<"literal" | "target">("literal"),
    [claimTargetId, setClaimTargetId] = useState(""),
    [claimFreshness, setClaimFreshness] = useState<ContextClaimItem["freshness"]>("current"),
    [claimSensitivity, setClaimSensitivity] = useState<ContextClaimItem["sensitivity"]>("normal"),
    [claimValidFrom, setClaimValidFrom] = useState(""),
    [claimValidTo, setClaimValidTo] = useState(""),
    [editingClaim, setEditingClaim] = useState<ContextClaimItem | null>(null),
    [claimStatus, setClaimStatus] = useState(""),
    [claimBusyIds, setClaimBusyIds] = useState<string[]>([]),
    [contextHistory, setContextHistory] = useState<ContextHistoryState>({ undo: null, redo: null, recent: [] }),
    [historyBusy, setHistoryBusy] = useState(false),
    [historyStatus, setHistoryStatus] = useState(""),
    // A refused step that can never succeed, offered for skipping together with the refusal.
    [historySkip, setHistorySkip] = useState<{ stack: "undo" | "redo"; eventId: string } | null>(null),
    // Which part of the Context view offers Undo for the edit that was just saved.
    [historyOffer, setHistoryOffer] = useState<"" | "claim" | "subject" | "inbox" | "evidence" | "source">(""),
    [contextInboxText, setContextInboxText] = useState(""),
    [contextInboxProposals, setContextInboxProposals] = useState<ContextInboxProposal[]>([]),
    [contextInboxTasks, setContextInboxTasks] = useState<ContextInboxTaskDraft[]>([]),
    [contextInboxBusy, setContextInboxBusy] = useState(""),
    [contextInboxStatus, setContextInboxStatus] = useState(""),
    [sortBy, setSortBy] = useState<"manual" | "date" | "priority" | "created">("manual"),
    [priorityFilter, setPriorityFilter] = useState("all"),
    [draggingId, setDraggingId] = useState(""),
    [dragTarget, setDragTarget] = useState(""),
    [checklistDraft, setChecklistDraft] = useState(""),
    [aiText, setAiText] = useState(""),
    [aiBusy, setAiBusy] = useState(false),
    [messages, setMessages] = useState<AssistantMessage[]>([]);
  // A workspace change invalidates both visible conversation content and replies still in flight.
  const assistantRequestVersion = useRef(0);
  const { items, relations, unsent, heldBack, heldReasons, syncStatus, setSyncStatus, serverRevision, syncQueue, localDataVersion, signedOut, pendingKey,
    deletedKey, revivedKey, pendingDeletedIds, pendingRevivedIds, load, applySnapshot, replaceLocalWithServer, restoreGeneration, restoredSinceKnown, adoptServerCopy, showRestoredNotice, restoredNotice, dismissRestoredNotice, putSnapshot, syncToServer,
    pullFromServer, tabId, captureMarkers, clearSentMarkers,
    recoveryHeld, recoveryPreparing, recoveryReady, recoveryError, recoveryOffline, recoveryDownloadRequested,
    recoveryInspecting, recoveryInspection, recoveryInspectionError, inspectOfflineRecoveryFile,
    prepareOfflineRecoveryDownload, downloadOfflineRecovery } = useSync();
  // Reconcile each project independently against acknowledged base data and
  // deletion markers. A successful sync of B must not dismiss failed A.
  useEffect(() => {
    const warnings = Object.values(projectSyncNotices);
    if (!warnings.length) return;
    let cancelled = false;
    void db.transaction("r", db.entities, db.baseEntities, async () => {
      const pendingDeletions = new Set(pendingDeletedIds());
      const resolved: ProjectSyncNotice[] = [];
      for (const warning of warnings) {
        const local = await db.entities.get(warning.projectId);
        const acknowledged = await db.baseEntities.get(warning.projectId);
        if (projectSyncNoticeResolved(warning, local, acknowledged,
          pendingDeletions.has(warning.projectId))) resolved.push(warning);
      }
      return resolved;
    }).then((resolved) => {
      if (cancelled || !resolved.length) return;
      setProjectSyncNotices((current) => withoutResolvedProjectSyncNotices(current, resolved));
    }, () => undefined);
    return () => { cancelled = true; };
  }, [projectSyncNotices, syncStatus, items]);
  // The translator reads the current language when it is called, so a message set after a request
  // that was started before a language change is shown in the new language.
  const languageRef = useRef(language);
  languageRef.current = language;
  const tr = (key: string) => copy[languageRef.current][key] || key;
  const { authState, setAuthState, authStateRef, authEnabled, authPassword, setAuthPassword, authError, authNotice,
    sessionEndedHere, checkAccess, login, signInWithPasskey, passkeySupported, passkeyBusy, setPasskeyBusy } = useSignIn({
    tr,
    language,
    answerConfirm,
    isSignedOut: () => signedOut.current,
    showsOfflineView: () => offlineViewRef.current,
    afterSignIn: async () => {
      // A completed local purge invalidates the old restore generation. A
      // sibling may have purged after this tab initialized its own ref.
      if (localStorage.getItem(restoreGenerationKey) === null)
        restoreGeneration.current = undefined;
      // A crash midway through local sign-out must settle before a later
      // sign-in can mistake partially deleted rows for new user changes.
      if (localStorage.getItem("ai-executive-wipe-pending") === "1") {
        await finishInterruptedWipe();
        if (localStorage.getItem("ai-executive-wipe-pending") === "1") {
          setSyncStatus("offline");
          return;
        }
        restoreGeneration.current = undefined;
      }
      serverRevision.current = 0;
      await pullFromServer(true);
    },
  });
  // Relation and change labels in Context: `predicate_<name>` in the dictionary; an unknown one is
  // shown as it is.
  const contextPredicateLabel = (predicate: string) => {
    const key = `predicate_${predicate}`;
    const label = tr(key);
    return label === key ? predicate : label;
  };
  // The name of a source's provider: `sourceProvider_<name>` in the dictionary; an unknown one is shown as it is.
  const providerLabel = (provider: string) => {
    const key = `sourceProvider_${provider.replace(/[^A-Za-z0-9]+/g, "_")}`;
    const label = tr(key);
    return label === key ? provider : label;
  };
  // A relationship reads with its registry label in the interface language; from the target's side with the inverse.
  const relationLabel = (predicate: string, side: "forward" | "inverse" = "forward") => {
    const definition = getRelationDefinition(predicate);
    if (!definition) return contextPredicateLabel(predicate);
    return (side === "forward" ? definition.labels : definition.inverse)[language === "cs" ? "cs" : "en"];
  };
  const contextSubjectTypeLabel = (type: string) => {
    if (type === "person") return tr("person");
    if (type === "organization") return tr("organization");
    return tr(type);
  };
  const contextInboxReason = (reason: ContextInboxProposal["reason"] | ContextInboxTaskDraft["reason"]) => ({
    waiting: tr("theTextMentionsA"),
    importance: tr("theTextExplicitlyDescribes"),
    deadline: tr("theTextContainsAn"),
    preference: tr("theTextContainsA"),
    action_item: tr("thisLineLooksLike"),
  })[reason];
  const taskDraftCaptureText = (task: ContextInboxTaskDraft) => {
    const localDate = task.suggestedDate
      ? `${Number(task.suggestedDate.slice(8, 10))}.${Number(task.suggestedDate.slice(5, 7))}.${task.suggestedDate.slice(0, 4)}`
      : "";
    const priority = task.suggestedPriority === "high" ? "!" : task.suggestedPriority === "medium" ? "#medium" : task.suggestedPriority === "low" ? "#low" : "";
    return [task.title, priority, localDate].filter(Boolean).join(" ");
  };
  const deepLinkHandled = useRef(false);
  // Whether the open record's title was changed and not saved yet; that draft lives only in
  // `selected` until blur. Merely focusing the field is not a change.
  const titleEdited = useRef(false);
  // Counts key presses in the title, so that a save finishing later knows whether more was typed.
  const titleEditSeq = useRef(0);
  const addressableViews = [...views, "Settings"];
  const captureOpener = useRef<HTMLElement | null>(null);
  const captureModalRef = useRef<HTMLFormElement | null>(null);
  const captureSuggestionVersion = useRef(0);
  const captureAreaTouched = useRef(false);
  // B3: volatile, workspace/type/project-scoped drafts. Draft text is not
  // persisted as an entity before Save; task suggestions DO send text to our
  // server while typing (see the UI notice and /api/task-suggestions).
  const captureDrafts = useRef(new Map<string, string>());
  const captureDraftKey = useRef("task:personal:");
  // A save can finish after another capture has opened. Only clear the exact
  // generation that was actually committed locally, never a newer edit.
  const captureDraftRevisions = useRef(new Map<string, number>());
  const draggingIdRef = useRef("");
  const dragScopeRef = useRef("");
  const dragTargetRef = useRef("");
  const pointerDragRef = useRef({ id: "", startX: 0, startY: 0, active: false });
  const calendarLoadVersion = useRef(0);
  // The task a calendar event just became: its Undo removes that task instead of restoring a record.
  const undoCreated = useRef<Entity | null>(null);
  const undoDecisions = useRef<CalendarDecisionUndo | null>(null);
  // Every newly opened or closed inspector invalidates a context request that is still running.
  // This prevents a slow request for A from replacing the context after the user opened B.
  const inspectionVersion = useRef(0);
  const openProjectIdRef = useRef(openProjectId);
  openProjectIdRef.current = openProjectId;
  // popstate is registered once; always resolve its target against the latest
  // authenticated local snapshot and active legacy scope, not mount-time state.
  const latestItemsRef = useRef(items);
  latestItemsRef.current = items;
  const latestRelationsRef = useRef(relations);
  latestRelationsRef.current = relations;
  const inspectRef = useRef<(item: Entity, options?: { navigate?: boolean }) => Promise<void>>(async () => undefined);
  // Cross-workspace URL inspection starts only after React commits the new
  // workspace. An eager inspect would lose context at the scope-change guard.
  const pendingRecordRef = useRef<{ kind: "task" | "note"; id: string; view: string; projectId?: string; workspaceId: string } | null>(null);
  const selectWorkspaceRef = useRef<(workspaceId: string) => void>(() => undefined);
  const visibleProjectsRef = useRef<Entity[]>([]);
  // UI-01d: each user-opened project history entry owns its own Back opener.
  // Keep the intents in memory only; a pasted/reloaded history state never grants access.
  const projectFocusEntriesRef = useRef(new Map<string, ProjectFocusEntry<HTMLElement>>());
  // Includes list origins and direct-link origins, not only project destinations.
  const knownProjectFocusPositionsRef = useRef(new Set<string>());
  const activeProjectFocusEntryRef = useRef<string | null>(null);
  const pendingProjectFocusRef = useRef<ProjectFocusEntry<HTMLElement> | null>(null);
  const inspectorSelectionRef = useRef(selected);
  inspectorSelectionRef.current = selected;
  const activeWorkspaceRef = useRef(activeWorkspaceId);
  activeWorkspaceRef.current = activeWorkspaceId;
  // A confirmation outlives its render; hold the live pending/held state for commit-time checks.
  const previewWriteGuardsRef = useRef({ unsent, heldBack });
  previewWriteGuardsRef.current = { unsent, heldBack };
  const pendingProjectWrites = useRef(new Map<string, Set<Promise<unknown>>>());
  function trackProjectWrite(projectId: string, write: Promise<unknown>) {
    const active = pendingProjectWrites.current.get(projectId) ?? new Set<Promise<unknown>>();
    active.add(write);
    pendingProjectWrites.current.set(projectId, active);
    const settle = () => {
      active.delete(write);
      if (active.size === 0) pendingProjectWrites.current.delete(projectId);
    };
    void write.then(settle, settle);
    return write;
  }
  async function waitForProjectWrites(projectId: string) {
    await waitForProjectPreviewWrites(() => [...(pendingProjectWrites.current.get(projectId) ?? [])]);
  }
  useEffect(() => {
    // A workspace transition makes any earlier inspection result ineligible.
    inspectionVersion.current += 1;
    setContext(null);
  }, [activeWorkspaceId]);
  useEffect(() => {
    const pending = pendingRecordRef.current;
    if (!pending || pending.workspaceId !== activeWorkspaceId) return;
    // Keep the pending URL marker until the selection has actually committed.
    // Otherwise the URL-sync effect in this render still sees selected=null
    // and replaces the deep link with a view-only address.
    const target = targetFromSearch(window.location.search, addressableViews, startupView);
    if ((target?.kind !== "task" && target?.kind !== "note") ||
        target.id !== pending.id || target.kind !== pending.kind || target.view !== pending.view ||
        target.projectId !== pending.projectId) {
      pendingRecordRef.current = null;
      return;
    }
    const destination = resolveLegacyRecordLink(items, relations, target, activeWorkspaceId);
    if (destination && !destination.selectWorkspaceId)
      void inspectRef.current(destination.record, { navigate: false });
    else pendingRecordRef.current = null;
  }, [activeWorkspaceId, items, relations, startupView]);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const moreDialogRef = useRef<HTMLDivElement>(null);
  const moreFocusDestinationRef = useRef<string | null>(null);
  const currentViewForMoreFocusRef = useRef(view);
  currentViewForMoreFocusRef.current = view;
  function markMobileMoreNavigation(destination: string) {
    if (mobileDesignV1Preview) moreFocusDestinationRef.current = destination;
  }
  const contextClaimLoadVersion = useRef(0);
  const contextHistoryLoadVersion = useRef(0);
  // Keyboard shortcuts can arrive before React renders a committed history response.
  // Keep the authoritative newest stack synchronously available to the handler.
  const currentContextHistory = useRef<ContextHistoryState>({ undo: null, redo: null, recent: [] });
  const contextShortcut = useRef<{ active: boolean; run: (action: "undo" | "redo") => void }>({ active: false, run: () => undefined });
  // Only one pending keyboard intent per workspace while an Undo/Redo is in flight.
  // A quick Redo must not disappear just because the preceding Undo is still
  // refreshing; the queued action is resolved against the server's new stack.
  const pendingContextShortcut = useRef<{ workspaceId: string; action: "undo" | "redo"; epoch: number } | null>(null);
  // A→B→A (or Context→Home→Context) is a new interaction session even if
  // its current workspace/view matches the original request again.
  const contextShortcutEpoch = useRef(0);
  useLayoutEffect(() => {
    contextShortcutEpoch.current += 1;
    pendingContextShortcut.current = null;
  }, [activeWorkspaceId, writeWorkspaceId, view, authState, capture, assistantOpen, moreOpen]);
  const calendarWorkspaceSelection = useRef("personal");
  calendarWorkspaceSelection.current = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
  // Context commands. One user intent keeps one idempotency key (and, for a new object, one id)
  // until it succeeds or the draft behind it changes, so a retry after a lost response is the same
  // command and cannot duplicate. The refs below also bind every response to the object it was
  // requested for, not to whatever the editor shows when it arrives.
  const contextIntents = useRef(new Map<string, { signature: string; commandKey: string; objectId: string }>());
  const contextInFlight = useRef(new Set<string>());
  const claimEditor = useRef({ objectId: "", nonce: 0, signature: "", subjectId: "" });
  const subjectDraft = useRef({ newTitle: "", editId: "", editTitle: "" });
  const contextIntent = (scope: string, signature: string) => {
    setHistoryOffer("");
    const current = contextIntents.current.get(scope);
    if (current && current.signature === signature) return current;
    const next = { signature, commandKey: crypto.randomUUID(), objectId: crypto.randomUUID() };
    contextIntents.current.set(scope, next);
    return next;
  };
  const finishContextIntent = (scope: string) => { contextIntents.current.delete(scope); };
  const claimDraftSignature = JSON.stringify([claimSubjectId, claimPredicate, claimValue, claimValueType, claimValueMode, claimTargetId,
    claimFreshness, claimSensitivity, claimValidFrom, claimValidTo]);
  // The relation select offers exactly the registered relations that link the chosen kinds of items; a literal
  // claim keeps its free-text predicate. A predicate that does not fit the chosen items counts as not chosen.
  const endpointType = (id: string) => standaloneSubjects.find((subject) => subject.id === id)?.type ?? items.find((item) => item.id === id)?.type ?? "";
  const claimSubjectType = endpointType(claimSubjectId);
  const claimTargetType = endpointType(claimTargetId);
  const claimRelationOptions = claimValueMode === "target" && claimSubjectType && claimTargetType ? relationsBetween(claimSubjectType, claimTargetType) : [];
  const claimEffectivePredicate = claimValueMode === "target"
    ? claimRelationOptions.some((entry) => entry.predicate === claimPredicate) ? claimPredicate : ""
    : claimPredicate.trim();
  claimEditor.current.objectId = editingClaim?.id || "";
  claimEditor.current.signature = claimDraftSignature;
  claimEditor.current.subjectId = claimSubjectId;
  subjectDraft.current = { newTitle: newSubjectTitle, editId: subjectEditId, editTitle: subjectEditTitle };
  const setClaimBusy = (key: string, busy: boolean) => {
    if (busy) contextInFlight.current.add(`claim:${key}`); else contextInFlight.current.delete(`claim:${key}`);
    setClaimBusyIds([...contextInFlight.current].filter((item) => item.startsWith("claim:")).map((item) => item.slice(6)));
  };
  const commandFailureMessage = (error: unknown, fallback: string) =>
    error instanceof TypeError ? tr("contextCommandUnconfirmed") : error instanceof Error ? error.message : fallback;
  // One confirmation at a time: asking again answers the previous question with "no".
  const confirmResolver = useRef<((confirmed: boolean) => void) | null>(null);
  // Set below where the offline view is decided; the app screen (and its dialog) is shown then too.
  const offlineViewRef = useRef(false);
  // The first request for the server copy, while it is still waiting for an answer.
  const startupStoreRequest = useRef<AbortController | null>(null);
  const deferInFlight = useRef(false);
  function askConfirm(request: ConfirmRequest) {
    confirmResolver.current?.(false);
    // The dialog lives in the app screen; without it a question could never be answered.
    if (authStateRef.current !== "ready" && !offlineViewRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      confirmResolver.current = resolve;
      setConfirmRequest(request);
    });
  }
  function answerConfirm(confirmed: boolean) {
    const resolve = confirmResolver.current;
    if (!resolve) return;
    confirmResolver.current = null;
    setConfirmRequest(null);
    resolve(confirmed);
  }
  // A question must not outlive the screen it was asked on.
  useEffect(() => {
    if (authState !== "ready") answerConfirm(false);
  }, [authState]);
  const sessionChannel = "ai-executive-session";
  // Explicit navigation away from a project creates its own history step.
  // Back then returns to the project, including when the next view is Projects (list).
  function setView(next: string, options?: { previewMyPlan?: boolean; keepAddress?: boolean }) {
    // Explicit navigation is not Back: never steal focus from the chosen nav control.
    pendingProjectFocusRef.current = null;
    activeProjectFocusEntryRef.current = null;
    setNavigationUnavailable(false);
    pendingRecordRef.current = null;
    const planPreview = mobileDesignV1Preview && next === "Today" && options?.previewMyPlan === true;
    setMobilePlanPreviewActive(planPreview);
    const exit = viewExitFromProject({
      currentSearch: window.location.search, currentProjectId: openProjectIdRef.current,
      nextView: next, knownViews: addressableViews, startView: startupView,
    });
    const route = targetFromSearch(window.location.search, addressableViews, startupView);
    // Choosing the active list while its record inspector is open is a real
    // navigation step. It must remain possible to go Back to that record.
    const leaveRecordSameView = !exit && (route?.kind === "task" || route?.kind === "note") &&
      next === view && route.id === inspectorSelectionRef.current?.id;
    if (exit || leaveRecordSameView) {
      try {
        // A project/record → My Plan click must remain exactly one history step.
        const nextSearch = planPreview ? "?view=MyPlanPreview" :
          exit?.search ?? searchForView(next, startupView);
        window.history.pushState(null, "", `${window.location.pathname}${nextSearch}`);
        addressedView.current = planPreview ? "MyPlanPreview" : next;
      } catch { /* The normal view effect handles unavailable History API. */ }
    } else if (shouldLeaveTypedAddress({ enabled: targetDetailsRef.current, keepAddress: Boolean(options?.keepAddress),
      search: window.location.search, targetViews: targetViewsRef.current })) {
      // R3-FE-4a: choosing a view while a target detail is open leaves it: one new history
      // step to the view-only address (the reading scope stays). keepAddress is for startup /
      // restore and for the caller that pushes the target address itself right after switching.
      try {
        const nextSearch = searchWithScope(planPreview ? "?view=MyPlanPreview" : searchForView(next, startupView),
          scopeFromSearch(window.location.search));
        window.history.pushState(null, "", `${window.location.pathname}${nextSearch}`);
        addressedView.current = planPreview ? "MyPlanPreview" : next;
        window.dispatchEvent(new Event(TARGET_ADDRESS_EVENT));
      } catch { /* The normal view effect handles unavailable History API. */ }
    }
    setViewState(next);
    setOpenProjectId(null);
  }
  // A project address is durable across reloads and devices. History state is only
  // a hint that a Back step was created in this tab, never an access grant.
  function openProjectPage(project: Entity) {
    // R3-FE-4a: where Projects is a target view, legacy project pages (and their legacy IDs in the address) do not exist.
    if (captureDisabledRef.current && targetViewsRef.current.includes("Projects")) return;
    // A stale sidebar/search result must not open a project outside the current scope.
    if (!visibleProjectsRef.current.some((visible) => visible.id === project.id && visible.workspaceId === project.workspaceId)) return;
    pendingProjectFocusRef.current = null;
    let opener: HTMLElement | null = null;
    if (mobileDesignV1Preview) {
      const active = document.activeElement;
      const focusedButton = active instanceof HTMLElement && active.dataset.projectOpen === project.id ? active : null;
      // Clicking the nonfocusable row background still has a matching list button.
      const listButton = [...document.querySelectorAll<HTMLButtonElement>("button[data-project-open]")]
        .find((button) => button.dataset.projectOpen === project.id && button.closest(".content"));
      opener = focusedButton ?? listButton ?? null;
    }
    closeDetail();
    setNavigationUnavailable(false);
    try {
      const projectAddress = `${window.location.pathname}${searchForTarget({ kind: "project", id: project.id }, startupView, addressableViews)}`;
      const current = targetFromSearch(window.location.search, addressableViews, startupView);
      if (current?.kind === "project" && current.id === project.id) {
        // Re-opening the same history entry is not a new Back origin.
        window.history.replaceState(window.history.state ?? { lumiProject: project.id }, "", projectAddress);
      } else {
        const focusEntryId = mobileDesignV1Preview ? crypto.randomUUID() : null;
        const originSearch = window.location.search;
        const originProjectId = openProjectIdRef.current;
        let originPositionId: string | null = null;
        if (mobileDesignV1Preview) {
          // Mark the *origin* entry too, including the Projects list. Unlike a
          // URL, this position distinguishes A₁ from a later visit to A₂.
          originPositionId = knownProjectFocusPosition(
            window.history.state, knownProjectFocusPositionsRef.current);
          if (!originPositionId) {
            originPositionId = crypto.randomUUID();
            const originalState = window.history.state;
            window.history.replaceState({
              ...(originalState && typeof originalState === "object" ? originalState : {}),
              lumiFocusEntry: originPositionId,
            }, "", window.location.href);
            knownProjectFocusPositionsRef.current.add(originPositionId);
          }
        }
        window.history.pushState({
          lumiProject: project.id,
          ...(focusEntryId ? { lumiFocusEntry: focusEntryId } : {}),
        }, "", projectAddress);
        if (focusEntryId) knownProjectFocusPositionsRef.current.add(focusEntryId);
        activeProjectFocusEntryRef.current = focusEntryId;
        if (focusEntryId && originPositionId && opener) {
          projectFocusEntriesRef.current.set(focusEntryId, {
            intent: { projectId: project.id, workspaceId: activeWorkspaceRef.current, view,
              source: opener.closest("aside") ? "sidebar" : "content",
              originSearch, originProjectId, originPositionId },
            opener,
          });
        }
      }
    } catch { /* Navigation still works in memory when History API is unavailable. */ }
    // One history step returns to the actual origin (Home/Today/list/other project),
    // never to a synthetic Projects entry that the user did not visit.
    setViewState("Projects");
    setOpenProjectId(project.id);
  }
  function closeProjectPage() {
    if (window.history.state?.lumiProject) window.history.back();
    else {
      activeProjectFocusEntryRef.current = null;
      pendingProjectFocusRef.current = null;
      setOpenProjectId(null);
      // A direct link may have no in-app history. Close to the safe Projects list.
      try { window.history.replaceState(null, "", `${window.location.pathname}${searchForView("Projects", startupView)}`); }
      catch { /* The in-memory list remains available. */ }
    }
  }
  // A Back from B→A restores B's sidebar opener on A; the next Back
  // from A→list independently restores A's original row. Forward never
  // borrows an unrelated entry's focus intent.
  useEffect(() => {
    if (!mobileDesignV1Preview || !pendingProjectFocusRef.current) return;
    const pending = pendingProjectFocusRef.current;
    // An intervening navigation or a revoked typed destination invalidates
    // the pending return; no search/ID is a source of ACL authority.
    if (window.location.search !== pending.intent.originSearch ||
        knownProjectFocusPosition(window.history.state, knownProjectFocusPositionsRef.current) !==
          pending.intent.originPositionId ||
        (authState !== "ready" && !offlineViewRef.current)) {
      pendingProjectFocusRef.current = null;
      return;
    }
    // Wait for popstate's destination, including any workspace transition,
    // to commit before inspecting visible buttons or consuming the intent.
    if (openProjectId !== pending.intent.originProjectId ||
        view !== pending.intent.view || activeWorkspaceId !== pending.intent.workspaceId) return;
    pendingProjectFocusRef.current = null;
    const visible = visibleProjectsRef.current.some((item) =>
      item.id === pending.intent.projectId && item.workspaceId === pending.intent.workspaceId);
    if (!shouldRestoreProjectFocus(pending.intent,
      { openProjectId, workspaceId: activeWorkspaceId, view, search: window.location.search,
        positionId: knownProjectFocusPosition(window.history.state, knownProjectFocusPositionsRef.current) }, visible)) return;
    const eligible = (button: HTMLElement) =>
      button.isConnected && button.dataset.projectOpen === pending.intent.projectId &&
      button.getClientRects().length > 0;
    const candidates = [...document.querySelectorAll<HTMLButtonElement>("button[data-project-open]")]
      .filter(eligible);
    const sameSource = (button: HTMLElement) =>
      pending.intent.source === "sidebar" ? Boolean(button.closest("aside")) : Boolean(button.closest(".content"));
    const target = eligible(pending.opener) ? pending.opener :
      candidates.find(sameSource) ?? candidates[0];
    target?.focus({ preventScroll: true });
  }, [openProjectId, activeWorkspaceId, view, items, authState]);
  async function inspect(e: Entity, options: { navigate?: boolean } = {}) {
    if (options.navigate !== false) {
      pendingRecordRef.current = null;
      if (e.type !== "project") {
        pendingProjectFocusRef.current = null;
        activeProjectFocusEntryRef.current = null;
      }
    }
    if (e.type === "project") { openProjectPage(e); return; }
    // The legacy owner store and selected workspace are the only local read
    // boundaries here; the target model's server authorization arrives in UI-09.
    if (activeWorkspaceRef.current !== "all" && activeWorkspaceRef.current !== e.workspaceId && options.navigate !== false) return;
    if (options.navigate !== false && (e.type === "task" || e.type === "note")) {
      const parent = view === "Projects" && openProjectIdRef.current &&
        legacyRecordBelongsToProject(e, openProjectIdRef.current, latestRelationsRef.current)
        ? openProjectIdRef.current : null;
      try {
        const target = { kind: e.type, id: e.id, view, ...(parent ? { projectId: parent } : {}) };
        const address = `${window.location.pathname}${searchForTarget(target, startupView, addressableViews)}`;
        const prior = targetFromSearch(window.location.search, addressableViews, startupView);
        const same = prior?.kind === e.type && prior.id === e.id &&
          prior.view === view && (prior.projectId ?? null) === parent;
        if (!same) window.history.pushState({ lumiRecord: e.id }, "", address);
        addressedView.current = view;
      } catch { /* In-memory inspector remains usable if the History API fails. */ }
      if (!parent && openProjectIdRef.current) setOpenProjectId(null);
    }
    setNavigationUnavailable(false);
    const version = ++inspectionVersion.current;
    const workspaceAtRequest = activeWorkspaceRef.current;
    setSelected(e);
    // A previous record's context must disappear immediately and must never reach the next
    // inspector. Both the selected record and the workspace must still match after the await.
    setContext(null);
    const next = await buildContext(e.id, 2);
    const stillOpen = inspectorSelectionRef.current;
    if (version !== inspectionVersion.current ||
        activeWorkspaceRef.current !== workspaceAtRequest ||
        (workspaceAtRequest !== "all" && workspaceAtRequest !== e.workspaceId) ||
        !stillOpen || stillOpen.id !== e.id || stillOpen.workspaceId !== e.workspaceId) return;
    setContext(next);
  }
  inspectRef.current = inspect;
  function closeDetail() {
    inspectionVersion.current += 1;
    setSelected(null);
    setContext(null);
  }
  // User-driven Close/Back follows the actual in-tab origin. A pasted URL has
  // no known in-app predecessor, so it replaces itself with the safe parent
  // project or view list rather than escaping to a different site.
  function closeInspector() {
    const target = targetFromSearch(window.location.search, addressableViews, startupView);
    const isLinked = (target?.kind === "task" || target?.kind === "note") &&
      inspectorSelectionRef.current?.id === target.id;
    if (!isLinked) { closeDetail(); return; }
    if (window.history.state?.lumiRecord === target.id) {
      window.history.back();
      return;
    }
    closeDetail();
    const search = target.projectId
      ? searchForTarget({ kind: "project", id: target.projectId }, startupView, addressableViews)
      : searchForView(target.view, startupView);
    setOpenProjectId(target.projectId ?? null);
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${search}`);
      addressedView.current = target.view;
    } catch { /* The address synchronization effect handles the fallback. */ }
  }
  async function askAI(promptOverride?: string) {
    // R3-FE-4a: no target API for this legacy action yet; unified mode keeps it inert.
    if (blockLegacyWrite()) return;
    const prompt = typeof promptOverride === "string" ? promptOverride.trim() : aiText.trim();
    if (!prompt || aiBusy) return;
    const requestVersion = assistantRequestVersion.current;
    const user: { role: "user"; content: string } = {
      role: "user",
      content: prompt,
    };
    const history = [...messages, user];
    setMessages(history);
    setAiText("");
    // Access could not be checked (an offline start): the assistant cannot be reached, and asking
    // would wait on a stalled connection instead of saying so.
    if (authStateRef.current === "unavailable") {
      setMessages([...history, { role: "assistant", content: tr("assistantOffline") }]);
      return;
    }
    setAiBusy(true);
    try {
      await syncQueue.current;
      if (localStorage.getItem(pendingKey) === "1") await syncToServer();
      if (requestVersion !== assistantRequestVersion.current) return;
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, content }) => ({ role, content })),
          workspaceId: activeWorkspaceId,
          writeWorkspaceId,
          focusEntityId: context?.focus.id,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (requestVersion !== assistantRequestVersion.current) return;
      if (!response.ok) throw new Error(localizeServerError(result.error, tr) || tr("assistantRequestFailed"));
      setMessages([...history, {
        role: "assistant",
        content: result.message,
        proposal: result.proposal,
      }]);
    } catch (error) {
      if (requestVersion !== assistantRequestVersion.current) return;
      setMessages([...history, {
        role: "assistant",
        // A request that did not reach the server (no connection) is said in the interface
        // language, not with the browser's own message.
        content: error instanceof TypeError ? tr("assistantOffline") : error instanceof Error ? error.message : tr("assistantRequestFailed"),
      }]);
    } finally {
      if (requestVersion === assistantRequestVersion.current) setAiBusy(false);
    }
  }

  async function resolveAIProposal(proposalId: string, action: "confirm" | "cancel") {
    // R3-FE-4a: no target API for this legacy action yet; unified mode keeps it inert.
    if (blockLegacyWrite()) return;
    if (aiBusy) return;
    const requestVersion = assistantRequestVersion.current;
    setAiBusy(true);
    try {
      const response = await fetch("/api/ai/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, proposalId }),
      });
      const result = await response.json().catch(() => ({}));
      if (requestVersion !== assistantRequestVersion.current) return;
      if (!response.ok) {
        const message = localizeServerError(result.error, tr) || tr("aiActionFailed");
        if (response.status === 409 && action === "confirm") {
          setMessages((current) => current.map((item) => item.proposal?.id === proposalId ? { ...item, blocked: message } : item));
        }
        throw new Error(message);
      }
      setMessages((current) => [
        ...current.map((message) =>
          message.proposal?.id === proposalId || (action === "confirm" && message.actionId)
            ? { ...message, resolved: true }
            : message,
        ),
        {
          role: "assistant",
          content: action === "confirm" ? result.message : tr("proposalDiscarded"),
          actionId: result.actionId,
        },
      ]);
      if (action === "confirm") await pullFromServer();
    } catch (error) {
      if (requestVersion !== assistantRequestVersion.current) return;
      setMessages((current) => [...current, {
        role: "assistant",
        content: error instanceof Error ? error.message : tr("aiActionFailed"),
      }]);
    } finally {
      if (requestVersion === assistantRequestVersion.current) setAiBusy(false);
    }
  }

  async function undoAIAction(actionId: string) {
    // R3-FE-4a: no target API for this legacy action yet; unified mode keeps it inert.
    if (blockLegacyWrite()) return;
    if (aiBusy) return;
    const requestVersion = assistantRequestVersion.current;
    setAiBusy(true);
    try {
      const response = await fetch("/api/ai/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "undo", actionId }),
      });
      const result = await response.json().catch(() => ({}));
      if (requestVersion !== assistantRequestVersion.current) return;
      if (!response.ok) throw new Error(localizeServerError(result.error, tr) || tr("undoFailed"));
      setMessages((current) => [
        ...current.map((message) => message.actionId === actionId ? { ...message, resolved: true } : message),
        { role: "assistant", content: result.message },
      ]);
      await pullFromServer();
    } catch (error) {
      if (requestVersion !== assistantRequestVersion.current) return;
      setMessages((current) => [...current, {
        role: "assistant",
        content: error instanceof Error ? error.message : tr("undoFailed"),
      }]);
    } finally {
      if (requestVersion === assistantRequestVersion.current) setAiBusy(false);
    }
  }
  const contextScopeLoaded = useRef("");

  async function loadAgents(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const response = await fetch(`/api/executive?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(tr("agentsUnavailable"));
    const data = await response.json();
    setPactAgents(Array.isArray(data.agents) ? data.agents : []);
    setAgentRuns(Array.isArray(data.agentRuns) ? data.agentRuns : []);
  }

  async function runPACTAgent(agentId: string) {
    // R3-FE-4a: no target API for this legacy action yet; unified mode keeps it inert.
    if (blockLegacyWrite()) return;
    if (agentBusyId) return;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setAgentBusyId(agentId);
    setAgentStatus("");
    setAgentResult(null);
    try {
      const response = await fetch("/api/executive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, workspaceId, language }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("agentRunFailed"));
      if (data.agentResult) setAgentResult(data.agentResult as PACTAgentResult);
      await loadAgents(workspaceId);
    } catch (error) {
      setAgentStatus(error instanceof Error ? error.message : tr("agentRunFailed"));
    } finally {
      setAgentBusyId("");
    }
  }

  async function loadCalendar(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const loadVersion = ++calendarLoadVersion.current;
    const from = Date.now() - 24 * 60 * 60_000;
    const to = Date.now() + 14 * 24 * 60 * 60_000;
    const response = await fetch(`/api/calendar?workspaceId=${encodeURIComponent(workspaceId)}&from=${from}&to=${to}`, { cache: "no-store" });
    if (!response.ok) throw new Error(tr("calendarUnavailable"));
    const data = await response.json();
    if (loadVersion !== calendarLoadVersion.current || calendarWorkspaceSelection.current !== workspaceId) return;
    setCalendarSources(Array.isArray(data.sources) ? data.sources : []);
    setCalendarEvents(Array.isArray(data.events) ? data.events : []);
    setCalendarFreshNow(Date.now());
    setCalendarLoadSucceededVersion(loadVersion);
  }

  async function calendarAction(action: "connect" | "refresh" | "disconnect", sourceId?: string) {
    if (calendarBusy) return;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setCalendarBusy(true);
    setCalendarStatus("");
    try {
      const response = await fetch("/api/calendar", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, sourceId, workspaceId, label: calendarLabel, url: calendarUrl }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("calendarActionFailed"));
      setCalendarUrl("");
      await loadCalendar(workspaceId);
      await loadDayPlan(workspaceId, calendarToday);
      setCalendarStatus(tr(action === "connect" ? "calendarConnectedReadOnly" : action === "refresh" ? "calendarRefreshed" : "calendarWasDisconnected"));
    } catch (error) {
      setCalendarUrl("");
      await loadCalendar(workspaceId).catch(() => undefined);
      setCalendarStatus(error instanceof Error ? error.message : tr("calendarActionFailed"));
    } finally {
      setCalendarBusy(false);
    }
  }

  async function loadDurableContext(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const response = await fetch(`/api/context?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("contextUnavailable"));
    setDurableContext(Array.isArray(data.items) ? data.items : []);
  }

  async function contextAction(action: "create" | "archive", id?: string) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    if (contextBusy) return;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setContextBusy(true);
    setContextStatus("");
    try {
      const response = await fetch("/api/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "create" ? {
          action, workspaceId, scope: contextScope, sensitivity: contextSensitivity,
          title: contextTitle, content: contextContent,
          projectId: contextScope === "project" ? contextProjectId : undefined,
        } : { action, workspaceId, id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("contextActionFailed"));
      if (action === "create") {
        setContextTitle(""); setContextContent(""); setContextProjectId("");
        setContextStatus(tr("contextSaved"));
      }
      await loadDurableContext(workspaceId);
    } catch (error) {
      setContextStatus(error instanceof Error ? error.message : tr("contextActionFailed"));
    } finally {
      setContextBusy(false);
    }
  }

  async function loadContextClaims(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const loadVersion = ++contextClaimLoadVersion.current;
    const response = await fetch(`/api/context/claims?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("contextClaimsUnavailable"));
    if (loadVersion !== contextClaimLoadVersion.current || calendarWorkspaceSelection.current !== workspaceId) return;
    setContextClaims(Array.isArray(data.claims) ? data.claims : []);
  }

  async function loadStandaloneSubjects(workspaceId = calendarWorkspaceSelection.current) {
    const response = await fetch(`/api/context/subjects?workspaceId=${encodeURIComponent(workspaceId)}&includeArchived=true`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("subjectsUnavailable"));
    if (calendarWorkspaceSelection.current === workspaceId) setStandaloneSubjects(Array.isArray(data.subjects) ? data.subjects : []);
  }

  async function loadContextHistory(workspaceId = calendarWorkspaceSelection.current) {
    const loadVersion = ++contextHistoryLoadVersion.current;
    const response = await fetch(`/api/context/history?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("contextHistoryFailed"));
    if (loadVersion !== contextHistoryLoadVersion.current || calendarWorkspaceSelection.current !== workspaceId) return;
    const state: ContextHistoryState = { undo: data.undo ?? null, redo: data.redo ?? null, recent: Array.isArray(data.recent) ? data.recent : [] };
    currentContextHistory.current = state;
    setContextHistory(state);
    return state;
  }

  // After a saved edit the area where it was made offers Undo for it, and the history bar follows.
  // Only when this very command recorded a step and that step is the one on top: a save that changed
  // nothing (no step) never offers to undo some older, unrelated step.
  function offerContextUndo(area: "claim" | "subject" | "inbox" | "evidence" | "source", workspaceId: string, historyEventId: unknown) {
    setHistoryStatus("");
    setHistorySkip(null);
    if (typeof historyEventId !== "string") { setHistoryOffer(""); loadContextHistory(workspaceId).catch(() => undefined); return; }
    loadContextHistory(workspaceId).then((state) => setHistoryOffer(state && state.undo?.eventId === historyEventId ? area : "")).catch(() => undefined);
  }

  // What a step does, in words: "Renaming the person" with its target ("Jana → Jan"), for the history bar.
  const quote = (text: string) => language === "cs" ? `‚${text}‘` : `“${text}”`;
  const contextStepText = (step: ContextHistoryStep) => {
    const kind = step.subjectType === "organization" ? "organization" : "person";
    const action = step.objectType === "claim"
      ? step.operation === "review" ? tr(`historyStepReview_${step.reviewStatus || "proposed"}`) : tr(`historyStep_${step.operation}`)
      : step.objectType === "source" || step.objectType === "evidence" ? tr(`historyStep_${step.operation.replace(".", "_")}`)
      : tr(`historyStep_${step.operation.replace(".", "_")}_${kind}`);
    const target = step.objectType === "claim" || step.objectType === "evidence" ? quote(contextPredicateLabel(step.label))
      : step.objectType === "source" ? quote(providerLabel(step.label))
      : step.operation === "subject.rename" && step.fromTitle && step.toTitle ? `${step.fromTitle} → ${step.toTitle}` : step.label;
    return { action, target };
  };

  // Once a command has succeeded, refreshing the lists is best effort: a failed refresh is not a failed
  // save, and the UI must already show the saved state so a new click cannot repeat a create.
  async function refreshAfterCommand(...loads: Array<() => Promise<void>>) {
    try { for (const load of loads) await load(); return true; } catch { return false; }
  }

  async function subjectAction(action: "create" | "rename" | "archive", subject?: StandaloneSubjectItem) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    const workspaceId = calendarWorkspaceSelection.current;
    const busyKey = `subject:${action}:${subject?.id || workspaceId}`;
    if (contextInFlight.current.has(busyKey)) return;
    const title = subject ? subjectEditTitle : newSubjectTitle;
    const scope = `subject:${action}:${subject?.id || workspaceId}`;
    // Only what this action sends decides whether a retry is the same intent: the new-subject type
    // means nothing to a rename, and neither the type nor a title to an archive.
    const intent = contextIntent(scope, JSON.stringify(action === "create" ? [workspaceId, newSubjectType, title]
      : action === "rename" ? [workspaceId, subject?.revision || 0, title] : [workspaceId, subject?.revision || 0]));
    const subjectId = subject?.id || intent.objectId;
    contextInFlight.current.add(busyKey);
    setSubjectBusy(true); setSubjectStatus("");
    try {
      const response = await fetch("/api/context/subjects", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, idempotencyKey: intent.commandKey, workspaceId,
          id: subjectId, expectedRevision: subject?.revision || 0,
          type: newSubjectType, title }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.code === "duplicate_subject" ? (tr("thisPersonOrOrganization")) : localizeServerError(data.error, tr) || tr("subjectActionFailed"));
      finishContextIntent(scope);
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      // Only the draft this response belongs to is closed; anything typed meanwhile stays.
      const draft = subjectDraft.current;
      if (action === "create") { if (draft.newTitle === title) setNewSubjectTitle(""); }
      else if (draft.editId === subject?.id && (action === "archive" || draft.editTitle === title)) { setSubjectEditId(""); setSubjectEditTitle(""); }
      setSubjectStatus(tr("saved"));
      offerContextUndo("subject", workspaceId, data.historyEventId);
      const refreshed = await refreshAfterCommand(() => loadStandaloneSubjects(workspaceId), () => loadContextClaims(workspaceId));
      if (!refreshed && calendarWorkspaceSelection.current === workspaceId) setSubjectStatus(tr("savedListNotRefreshed"));
    } catch (error) { if (calendarWorkspaceSelection.current === workspaceId) setSubjectStatus(commandFailureMessage(error, tr("subjectActionFailed"))); }
    finally {
      contextInFlight.current.delete(busyKey);
      setSubjectBusy([...contextInFlight.current].some((key) => key.startsWith("subject:")));
    }
  }

  async function showSubjectHistory(subject: StandaloneSubjectItem) {
    const workspaceId = calendarWorkspaceSelection.current;
    try {
      const response = await fetch(`/api/context/subjects?workspaceId=${encodeURIComponent(workspaceId)}&historyId=${encodeURIComponent(subject.id)}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("historyUnavailable"));
      if (calendarWorkspaceSelection.current === workspaceId) setSubjectHistory((current) => ({ ...current, [subject.id]: Array.isArray(data.history) ? data.history : [] }));
    } catch (error) { setSubjectStatus(error instanceof Error ? error.message : tr("historyUnavailable")); }
  }

  async function reloadContextClaims() {
    const workspaceId = calendarWorkspaceSelection.current;
    setClaimStatus(tr("reloading"));
    try {
      await loadContextClaims(workspaceId);
      loadContextHistory(workspaceId).catch(() => undefined);
      if (calendarWorkspaceSelection.current === workspaceId) setClaimStatus(tr("claimsReloadedYourDraft"));
    } catch (error) {
      if (calendarWorkspaceSelection.current === workspaceId) setClaimStatus(error instanceof Error ? error.message : tr("contextClaimsUnavailable"));
    }
  }

  async function showClaimHistory(claim: ContextClaimItem) {
    const workspaceId = calendarWorkspaceSelection.current;
    try {
      const response = await fetch(`/api/context/claims?workspaceId=${encodeURIComponent(workspaceId)}&claimId=${encodeURIComponent(claim.id)}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("claimHistoryUnavailable"));
      if (calendarWorkspaceSelection.current === workspaceId) setClaimHistory((current) => ({ ...current, [claim.id]: Array.isArray(data.history) ? data.history : [] }));
    } catch (error) { if (calendarWorkspaceSelection.current === workspaceId) setClaimStatus(error instanceof Error ? error.message : tr("claimHistoryUnavailable")); }
  }

  function resetClaimDraft() {
    claimEditor.current.nonce += 1;
    // A draft that is given up does not keep its idempotency key for a later, similar draft.
    for (const key of [...contextIntents.current.keys()]) if (key.startsWith("claim:save:") && key.includes(":new:")) contextIntents.current.delete(key);
    setEditingClaim(null);
    setClaimSubjectId("");
    setClaimPredicate("preference");
    setClaimValue("");
    setClaimValueType("string");
    setClaimValueMode("literal");
    setClaimTargetId("");
    setClaimFreshness("current");
    setClaimSensitivity("normal");
    setClaimValidFrom("");
    setClaimValidTo("");
  }

  function editContextClaim(claim: ContextClaimItem, scroll = true) {
    claimEditor.current.nonce += 1;
    setEditingClaim(claim);
    setClaimSubjectId(claim.subject.canonicalEntityId || claim.subject.id);
    // A relationship outside the registry has to be edited to one inside it: the select starts empty.
    setClaimPredicate(claim.target && claim.relationStatus !== "registered" ? "" : claim.predicate);
    setClaimValue(String(claim.literal?.value ?? ""));
    setClaimValueType(claim.literal?.type || "string");
    setClaimValueMode(claim.target ? "target" : "literal");
    setClaimTargetId(claim.target?.canonicalEntityId || claim.target?.id || "");
    setClaimFreshness(claim.freshness);
    setClaimSensitivity(claim.sensitivity);
    setClaimValidFrom(claim.validFrom || "");
    setClaimValidTo(claim.validTo || "");
    setClaimStatus("");
    if (scroll) window.setTimeout(() => document.getElementById("context-claim-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function saveContextClaim() {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    const workspaceId = calendarWorkspaceSelection.current;
    const target = editingClaim;
    const objectKey = target?.id || `new:${workspaceId}`;
    if (contextInFlight.current.has(`claim:${objectKey}`)) return;
    const sentSignature = claimDraftSignature;
    const sentNonce = claimEditor.current.nonce;
    const sentPredicate = claimEffectivePredicate;
    const scope = `claim:save:${objectKey}`;
    const intent = contextIntent(scope, JSON.stringify([workspaceId, target?.revision || 0, sentSignature]));
    const claimId = target?.id || intent.objectId;
    setClaimBusy(objectKey, true);
    setClaimStatus(tr("saving"));
    // True while the editor still shows the draft this request was sent for.
    const editorStillShows = () => target ? claimEditor.current.objectId === target.id
      : claimEditor.current.objectId === "" && claimEditor.current.nonce === sentNonce;
    try {
      const parsedValue = claimValueType === "number" ? Number(claimValue)
        : claimValueType === "boolean" ? claimValue === "true" : claimValue;
      const response = await fetch("/api/context/claims", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: target ? "update" : "create", idempotencyKey: intent.commandKey, workspaceId,
          id: claimId, expectedRevision: target?.revision || 0,
          subject: target ? undefined : standaloneSubjects.some((subject) => subject.id === claimSubjectId)
            ? { subjectId: claimSubjectId } : { entityId: claimSubjectId },
          predicate: sentPredicate, literal: claimValueMode === "literal" ? { type: claimValueType, value: parsedValue } : undefined,
          target: claimValueMode === "target" ? (standaloneSubjects.some((subject) => subject.id === claimTargetId)
            ? { subjectId: claimTargetId } : { entityId: claimTargetId }) : undefined,
          freshness: claimFreshness, sensitivity: claimSensitivity,
          validFrom: claimValidFrom || null, validTo: claimValidTo || null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.code === "duplicate_relation") throw new Error(tr("duplicateRelationError"));
        if (response.status === 409) throw new Error(tr("conflictTheClaimChanged"));
        if (data.code === "invalid_relation") throw new Error(tr("invalidRelationError"));
        throw new Error(localizeServerError(data.error, tr) || tr("claimSaveFailed"));
      }
      finishContextIntent(scope);
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      // The editor follows the saved claim before anything else can fail: a draft that still looked
      // unsaved would send a new create (new key and id) on the next click.
      if (!editorStillShows()) setClaimStatus(tr("saved"));
      else if (claimEditor.current.signature === sentSignature) {
        resetClaimDraft();
        setClaimStatus(target ? tr("saved") : tr("savedANewClaim"));
      } else {
        // Typed again while this was saved: the newer draft stays and continues from the saved revision.
        // The subject of a saved claim cannot change, so the editor shows the subject it was saved with.
        const saved = data.claim as ContextClaimItem | undefined;
        if (saved) {
          const savedSubjectId = saved.subject.canonicalEntityId || saved.subject.id;
          const subjectChanged = claimEditor.current.subjectId !== savedSubjectId;
          setEditingClaim(saved);
          setClaimSubjectId(savedSubjectId);
          setClaimStatus(subjectChanged ? tr("savedSubjectKept") : tr("saved"));
        } else setClaimStatus(tr("saved"));
      }
      offerContextUndo("claim", workspaceId, data.historyEventId);
      if (!(await refreshAfterCommand(() => loadContextClaims(workspaceId))) && calendarWorkspaceSelection.current === workspaceId) {
        setClaimStatus(tr("savedListNotRefreshed"));
      }
    } catch (error) {
      if (calendarWorkspaceSelection.current === workspaceId) {
        const message = commandFailureMessage(error, tr("claimSaveFailed"));
        setClaimStatus(editorStillShows() ? message : `${contextPredicateLabel(sentPredicate)}: ${message}`);
      }
    } finally {
      setClaimBusy(objectKey, false);
    }
  }

  async function contextClaimAction(claim: ContextClaimItem, action: "review" | "archive", decision?: ContextClaimItem["reviewStatus"]) {
    // R3-FE-4a: no target API for this legacy action yet; unified mode keeps it inert.
    if (blockLegacyWrite()) return;
    const workspaceId = calendarWorkspaceSelection.current;
    if (contextInFlight.current.has(`claim:${claim.id}`)) return;
    const scope = `claim:${action}:${claim.id}`;
    const intent = contextIntent(scope, JSON.stringify([workspaceId, claim.revision, action, decision || null]));
    setClaimBusy(claim.id, true);
    setClaimStatus(tr("saving"));
    try {
      const response = await fetch("/api/context/claims", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, idempotencyKey: intent.commandKey, workspaceId, id: claim.id,
          expectedRevision: claim.revision, decision }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.code === "relation_needs_fix") throw new Error(tr("relationFixFirst"));
        if (response.status === 409) throw new Error(tr("conflictReloadTheCurrent"));
        throw new Error(localizeServerError(data.error, tr) || tr("claimActionFailed"));
      }
      finishContextIntent(scope);
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      // The editor is touched only when it shows this very claim: an archived claim cannot be edited
      // any more; a reviewed one keeps the draft and continues from the new revision.
      if (claimEditor.current.objectId === claim.id) {
        if (action === "archive") resetClaimDraft();
        else if (data.claim) setEditingClaim(data.claim as ContextClaimItem);
      }
      setClaimStatus(tr("saved"));
      offerContextUndo("claim", workspaceId, data.historyEventId);
      if (!(await refreshAfterCommand(() => loadContextClaims(workspaceId))) && calendarWorkspaceSelection.current === workspaceId) {
        setClaimStatus(tr("savedListNotRefreshed"));
      }
    } catch (error) {
      if (calendarWorkspaceSelection.current === workspaceId) {
        setClaimStatus(commandFailureMessage(error, tr("claimActionFailed")));
      }
    } finally {
      setClaimBusy(claim.id, false);
    }
  }

  // Undo/Redo of the top step of this workspace's history. The step the person saw is sent with the
  // request, so a history that moved on (another tab, a double click) is refused instead of undoing
  // something else. One intent keeps one key until it is answered; a refusal changes nothing.
  // "skip" is the owner's way out of a step that is refused for good: it drops that step from its stack
  // and changes no data.
  async function contextHistoryAction(action: "undo" | "redo" | "skip", after?: ContextHistoryState, keyboard = false) {
    // R3-FE-4a: no target API for this legacy action yet; unified mode keeps it inert.
    if (blockLegacyWrite()) return;
    const workspaceId = calendarWorkspaceSelection.current;
    const shortcutEpoch = contextShortcutEpoch.current;
    const skipping = action === "skip" ? historySkip : null;
    if (action === "skip" && !skipping) return;
    const side = skipping ? skipping.stack : action as "undo" | "redo";
    const busyKey = `history:${workspaceId}`;
    if (contextInFlight.current.has(busyKey)) {
      // Buttons are disabled while busy. For keyboard shortcuts, keep the latest
      // explicitly requested action rather than silently losing a quick Redo.
      if (keyboard && action !== "skip") pendingContextShortcut.current = { workspaceId, action, epoch: shortcutEpoch };
      return;
    }
    const step = skipping ? { eventId: skipping.eventId } : side === "undo" ? (after ?? currentContextHistory.current).undo : (after ?? currentContextHistory.current).redo;
    if (!step) return;
    const scope = `history:${action}:${side}:${workspaceId}`;
    const intent = contextIntent(scope, JSON.stringify([workspaceId, action, side, step.eventId]));
    contextInFlight.current.add(busyKey);
    setHistoryBusy(true); setHistoryStatus(""); setHistoryOffer(""); setHistorySkip(null);
    // The result of this action replaces what an earlier command said about itself.
    setClaimStatus(""); setSubjectStatus(""); setContextInboxStatus("");
    let committedHistory: ContextHistoryState | null = null;
    try {
      const response = await fetch("/api/context/history", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, idempotencyKey: intent.commandKey, workspaceId, expectedEventId: step.eventId, stack: skipping ? skipping.stack : undefined }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        // An answer from the server is final for this attempt; the next click is a new intent.
        finishContextIntent(scope);
        const reason = data.code === "history_changed" ? tr("contextHistoryChanged")
          : data.code === "undo_conflict" || data.code === "revision_conflict" ? tr("contextUndoConflict")
          : data.code === "duplicate_subject" ? tr("contextUndoDuplicate")
          : data.code === "archived_subject" || data.code === "invalid_subject" ? tr("contextUndoArchivedSubject")
          : localizeServerError(data.error, tr) || tr("contextHistoryFailed");
        if (calendarWorkspaceSelection.current === workspaceId) {
          setHistoryStatus(reason);
          // A step that can never succeed would block everything below it: the owner may skip it.
          if (!skipping && ["undo_conflict", "revision_conflict", "duplicate_subject", "archived_subject", "invalid_subject"].includes(data.code)) {
            setHistorySkip({ stack: side, eventId: step.eventId });
          }
          loadContextHistory(workspaceId).catch(() => undefined);
          refreshAfterCommand(() => loadContextClaims(workspaceId), () => loadStandaloneSubjects(workspaceId), () => loadContextSources(workspaceId));
        }
        return;
      }
      finishContextIntent(scope);
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      committedHistory = { undo: data.undo ?? null, redo: data.redo ?? null, recent: Array.isArray(data.recent) ? data.recent : [] };
      // A GET started before this command cannot overwrite its committed stack.
      contextHistoryLoadVersion.current += 1;
      currentContextHistory.current = committedHistory;
      setContextHistory(committedHistory);
      const text = contextStepText(data.step as ContextHistoryStep);
      setHistoryStatus(`${tr(action === "undo" ? "contextUndone" : action === "redo" ? "contextRedone" : "contextSkipped")} ${text.action} ${text.target}`);
      if (action === "skip") return;
      // The editor follows the claim when it shows it: an archived claim cannot be edited any more.
      if (data.objectType === "claim" && claimEditor.current.objectId === (data.object as ContextClaimItem).id) {
        if ((data.object as ContextClaimItem).archivedAt) resetClaimDraft(); else editContextClaim(data.object as ContextClaimItem, false);
      } else if (data.objectType === "evidence" && data.object?.claim) syncEditedClaim(data.object.claim as ContextClaimItem);
      await refreshAfterCommand(() => loadContextClaims(workspaceId), () => loadStandaloneSubjects(workspaceId), () => loadContextSources(workspaceId));
    } catch (error) {
      if (calendarWorkspaceSelection.current === workspaceId) setHistoryStatus(commandFailureMessage(error, tr("contextHistoryFailed")));
    } finally {
      contextInFlight.current.delete(busyKey);
      setHistoryBusy(false);
      const queued = pendingContextShortcut.current;
      if (queued?.workspaceId === workspaceId) {
        pendingContextShortcut.current = null;
        // Never replay a shortcut after a failed/refused command, a view
        // change or a workspace switch. Keep the exact server-provided next
        // stack rather than a potentially stale React render of history.
        if (committedHistory && queued.epoch === shortcutEpoch &&
            contextShortcutEpoch.current === shortcutEpoch &&
            calendarWorkspaceSelection.current === workspaceId && contextShortcut.current.active) {
          void contextHistoryAction(queued.action, committedHistory, true);
        }
      }
    }
  }
  // A claim whose revision moved because its evidence changed: the editor keeps the draft and follows the revision.
  const syncEditedClaim = (claim: ContextClaimItem) => { if (claimEditor.current.objectId === claim.id) setEditingClaim(claim); };
  const evidenceState = useContextEvidence({ authState, activeWorkspaceId, writeWorkspaceId, tr, calendarWorkspaceSelection, contextIntent, finishContextIntent,
    contextInFlight, commandFailureMessage, refreshAfterCommand, offerContextUndo, loadContextClaims, syncEditedClaim });
  const { loadContextSources } = evidenceState;
  contextShortcut.current = { active: view === "Context" && !capture && !assistantOpen && !moreOpen && authState === "ready", run: (action) => { void contextHistoryAction(action, undefined, true); } };

  async function previewContextInbox() {
    // R3-FE-4a: no target API for this legacy action yet; unified mode keeps it inert.
    if (blockLegacyWrite()) return;
    if (!contextInboxText.trim() || contextInboxBusy) return;
    const workspaceId = calendarWorkspaceSelection.current;
    setContextInboxBusy("preview"); setContextInboxStatus("");
    try {
      const response = await fetch("/api/context/inbox", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "preview", workspaceId, text: contextInboxText }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("contextPreviewFailed"));
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      setContextInboxProposals(Array.isArray(data.proposals) ? data.proposals : []);
      setContextInboxTasks(Array.isArray(data.taskDrafts) ? data.taskDrafts : []);
      setContextInboxStatus(tr("previewReadyTheOriginal"));
    } catch (error) { setContextInboxStatus(error instanceof Error ? error.message : tr("contextPreviewFailed")); }
    finally { setContextInboxBusy(""); }
  }

  async function approveContextInbox(proposal: ContextInboxProposal) {
    // R3-FE-4a: no target API for this legacy action yet; unified mode keeps it inert.
    if (blockLegacyWrite()) return;
    const workspaceId = calendarWorkspaceSelection.current;
    const busyKey = `inbox:${proposal.id}`;
    if (contextInboxBusy || contextInFlight.current.has(busyKey)) return;
    const body = {
      action: "approve", workspaceId,
      subjectId: proposal.subject.entityId, predicate: proposal.predicate,
      literal: proposal.suggestedTarget ? undefined : proposal.literal,
      targetSubjectId: proposal.suggestedTarget ? proposal.selectedTargetId : undefined,
      freshness: proposal.freshness, validFrom: proposal.validFrom,
      validTo: proposal.validTo, evidenceExcerpt: proposal.evidenceExcerpt,
    };
    const intent = contextIntent(busyKey, JSON.stringify(body));
    contextInFlight.current.add(busyKey);
    setContextInboxBusy(proposal.id); setContextInboxStatus("");
    try {
      const response = await fetch("/api/context/inbox", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, idempotencyKey: intent.commandKey, id: intent.objectId }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("contextProposalSaveFailed"));
      finishContextIntent(busyKey);
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      setContextInboxProposals((current) => current.filter((item) => item.id !== proposal.id));
      setContextInboxStatus(tr("proposalAddedToThe"));
      offerContextUndo("inbox", workspaceId, data.historyEventId);
      if (!(await refreshAfterCommand(() => loadContextClaims(workspaceId), () => loadContextSources(workspaceId))) && calendarWorkspaceSelection.current === workspaceId) {
        setContextInboxStatus(tr("savedListNotRefreshed"));
      }
    } catch (error) { if (calendarWorkspaceSelection.current === workspaceId) setContextInboxStatus(commandFailureMessage(error, tr("contextProposalSaveFailed"))); }
    finally { contextInFlight.current.delete(busyKey); setContextInboxBusy(""); }
  }

  async function createSuggestedTarget(proposal: ContextInboxProposal) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    const workspaceId = calendarWorkspaceSelection.current;
    const busyKey = `inbox-target:${proposal.id}`;
    if (!proposal.suggestedTarget || contextInboxBusy || contextInFlight.current.has(busyKey)) return;
    const intent = contextIntent(busyKey, JSON.stringify([workspaceId, proposal.suggestedTarget.type, proposal.suggestedTarget.title]));
    contextInFlight.current.add(busyKey);
    setContextInboxBusy(proposal.id); setContextInboxStatus("");
    try {
      const id = intent.objectId;
      const response = await fetch("/api/context/subjects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        action: "create", idempotencyKey: intent.commandKey, workspaceId, id, expectedRevision: 0,
        type: proposal.suggestedTarget.type, title: proposal.suggestedTarget.title,
      }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.code === "duplicate_subject" ? (tr("personExistsSelectThem")) : localizeServerError(data.error, tr) || tr("personCreateFailed"));
      finishContextIntent(busyKey);
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, selectedTargetId: id } : item));
      setContextInboxStatus(tr("personCreatedSaveThe"));
      offerContextUndo("inbox", workspaceId, data.historyEventId);
      if (!(await refreshAfterCommand(() => loadStandaloneSubjects(workspaceId))) && calendarWorkspaceSelection.current === workspaceId) {
        setContextInboxStatus(tr("savedListNotRefreshed"));
      }
    } catch (error) { if (calendarWorkspaceSelection.current === workspaceId) setContextInboxStatus(commandFailureMessage(error, tr("personCreateFailed"))); }
    finally { contextInFlight.current.delete(busyKey); setContextInboxBusy(""); }
  }

  useEffect(() => {
    if (authState !== "ready") return;
    loadAgents().catch(() => undefined);
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setCalendarSources([]);
    setCalendarEvents([]);
    loadCalendar(workspaceId).catch(() => undefined);
    loadDurableContext(workspaceId).catch(() => setContextStatus(tr("contextIsUnavailable")));
    setContextClaims([]);
    currentContextHistory.current = { undo: null, redo: null, recent: [] };
    setContextHistory(currentContextHistory.current);
    setHistoryStatus(""); setHistoryOffer("");
    loadContextHistory(workspaceId).catch(() => setHistoryStatus(tr("contextHistoryFailed")));
    setClaimHistory({});
    setStandaloneSubjects([]);
    setSubjectHistory({});
    // Drafts belong to a workspace. Signing in again in the same one must not discard them.
    const contextScope = `${activeWorkspaceId}|${workspaceId}`;
    if (contextScopeLoaded.current !== contextScope) {
      contextScopeLoaded.current = contextScope;
      setContextInboxProposals([]);
      setContextInboxTasks([]);
      setContextInboxStatus("");
      setClaimFilterId("all");
      setClaimStatus("");
      resetClaimDraft();
    }
    loadContextClaims(workspaceId).catch(() => setClaimStatus(tr("structuredContextIsUnavailable")));
    loadStandaloneSubjects(workspaceId).catch(() => setSubjectStatus(tr("peopleAndOrganizationsAre")));
  }, [authState, activeWorkspaceId, writeWorkspaceId]);

  useEffect(() => {
    const savedLanguage = localStorage.getItem("ai-executive-language");
    if (savedLanguage === "cs" || savedLanguage === "en") {
      setLanguage(savedLanguage);
    } else {
      setLanguage(navigator.language.toLowerCase().startsWith("cs") ? "cs" : "en");
    }
    const savedView = localStorage.getItem("ai-executive-startup-view");
    const savedWorkspace = localStorage.getItem(
      "ai-executive-active-workspace",
    );
    const savedWriteWorkspace = localStorage.getItem(
      "ai-executive-write-workspace",
    );
    const isPreviewPhone = mobileDesignV1Preview && window.matchMedia("(max-width: 700px)").matches;
    // The shared reading scope (?scope=) is not a navigation choice: it must not defeat the phone start.
    const previewMobileStart = isPreviewPhone && searchWithoutScope(window.location.search) === "";
    const previewDirectLink = mobileDesignV1Preview && (mobileV1IsPlanPreviewRoute(window.location.search) ||
      (targetDetailsRef.current && targetViewsRef.current.includes("MyPlanPreview") && isPlanDetailSearch(window.location.search)));
    if (previewMobileStart || previewDirectLink) {
      setMobilePlanPreviewActive(true);
      if (previewMobileStart) setStartupView("Today");
      setViewState("Today");
    } else if (savedView && views.includes(savedView)) {
      setStartupView(savedView);
      setView(savedView, { keepAddress: true });
    }
    // An explicit ordinary view (including ?view=Today) wins over the preview.
    const addressedView = viewFromSearch(window.location.search, addressableViews);
    if (addressedView) setView(addressedView, { keepAddress: true });
    setAddressReady(true);
    if (savedWorkspace) {
      setActiveWorkspaceId(savedWorkspace);
      setWriteWorkspaceId(
        savedWorkspace !== "all"
          ? savedWorkspace
          : savedWriteWorkspace || personalWorkspaceId,
      );
    }
    setStandalone(
      window.matchMedia("(display-mode: standalone)").matches ||
        Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    );
    async function initialize() {
      const initializationVersion = localDataVersion.current;
      // A persisted hold must survive reloads even when an older sign-out wipe was interrupted.
      // Do not migrate, seed, or clean any local data while rescue is required.
      if (offlineRecoveryIsHeld()) {
        await load();
        setSyncStatus("offline");
        return;
      }
      // Given up once the access check finds no connection, so a stalled request does not keep the
      // offline view empty: the data kept in this browser is shown instead (catch below).
      const storeRequest = new AbortController();
      startupStoreRequest.current = storeRequest;
      if (authStateRef.current === "unavailable") storeRequest.abort();
      try {
        const response = await fetch("/api/store", { cache: "no-store", signal: storeRequest.signal });
        if (!response.ok) throw new Error("Server synchronization failed");
        let snapshot = (await response.json()) as ServerSnapshot;
        // This is the earliest safe point to compare generations: no local write, migration
        // or interrupted wipe may happen before the persistent recovery marker is recorded.
        if (restoredSinceKnown(snapshot.restoreGeneration)) {
          // Adopt's mismatch branch persists the hold synchronously before the first await.
          await adoptServerCopy(snapshot, true);
          await load();
          setSyncStatus("offline");
          return;
        }
        // A sibling may have installed a hold while the GET was outstanding.
        if (offlineRecoveryIsHeld()) {
          await load();
          setSyncStatus("offline");
          return;
        }
        await finishInterruptedWipe();
        await ensureDefaultWorkspace();
        let localEntities = await db.entities.toArray();
        let localRelations = await db.relations.toArray();
        // Example data is only for a browser that has never synchronized: an account whose
        // server copy is empty (everything deleted) must stay empty.
        if (
          localStorage.getItem("ai-executive-server-synced") !== "1" &&
          !localEntities.some((entity) => entity.type !== "workspace") &&
          !snapshot.entities.some((entity) => entity.type !== "workspace")
        ) {
          await seed();
          await migratePropertyRelations();
          localEntities = await db.entities.toArray();
          localRelations = await db.relations.toArray();
        } else if (localEntities.length) {
          await migratePropertyRelations();
          localEntities = await db.entities.toArray();
          localRelations = await db.relations.toArray();
        }
        const alreadySynchronized =
          localStorage.getItem("ai-executive-server-synced") === "1";
        const hasPendingChanges = localStorage.getItem(pendingKey) === "1";
        // Nothing of this browser's own to send: the server copy is taken over the same way as on
        // every later refresh, fetched again while no other tab synchronizes. The copy fetched
        // above may already be older than a save another open tab has just made.
        if (alreadySynchronized && !hasPendingChanges) {
          await pullFromServer();
          return;
        }
        // The data was restored from a backup (on another device, or while this browser was away) since this browser last
        // held it: its unsent changes were made against data that no longer exists, so the server copy replaces them.
        if (alreadySynchronized && hasPendingChanges && restoredSinceKnown(snapshot.restoreGeneration)) {
          await replaceLocalWithServer(snapshot, true);
          return;
        }
        // What this start sends of the bookkeeping shared by all tabs; only that is removed.
        const sentMarkers = captureMarkers();
        let outgoing = forServer(localEntities, localRelations, null);
        if (!alreadySynchronized || hasPendingChanges) {
          const deletedIds = new Set(sentMarkers.deleted);
          const revivedIds = new Set(sentMarkers.revived);
          const filteredSnapshot = {
            ...snapshot,
            tombstones: (snapshot.tombstones || []).filter((item) => !revivedIds.has(item.id)),
            entities: snapshot.entities.filter(
              (entity) => !deletedIds.has(entity.id),
            ),
            relations: snapshot.relations.filter(
              (relation) =>
                !deletedIds.has(relation.sourceEntityId) &&
                !deletedIds.has(relation.targetEntityId),
            ),
          };
          // Read again together with the common version, so that the two belong together.
          const [entitiesNow, relationsNow, base] = await readLocalWithBase();
          localEntities = [...entitiesNow];
          localRelations = [...relationsNow];
          // A record the server would refuse is held back (lib/sendable.ts).
          outgoing = forServer(localEntities, localRelations, base);
          const merged = mergeSnapshots(
            filteredSnapshot,
            outgoing.entities,
            outgoing.relations,
            base,
          );
          let saveResponse = await putSnapshot(
            merged.entities,
            merged.relations,
            snapshot.revision,
            sentMarkers.deleted,
            sentMarkers.revived,
            snapshot.restoreGeneration,
          );
          if (saveResponse.status === 409) {
            snapshot = (await saveResponse.json()) as ServerSnapshot;
            // Restored between the read above and this save: what this start holds was made against data that no longer
            // exists. It is not merged and not sent again; the server's data replaces it (like every other adoption).
            if (snapshot.code === "restored" && restoredSinceKnown(snapshot.restoreGeneration)) {
              await replaceLocalWithServer(snapshot, true);
              return;
            }
            const retrySnapshot = {
              ...snapshot,
              tombstones: (snapshot.tombstones || []).filter(
                (item) => !revivedIds.has(item.id),
              ),
            };
            // The first merge was made from the server copy read at start, which is therefore its
            // common version with the newer one.
            const retry = mergeSnapshots(
              retrySnapshot,
              merged.entities,
              merged.relations,
              { entities: filteredSnapshot.entities, relations: filteredSnapshot.relations },
            );
            saveResponse = await putSnapshot(
              retry.entities,
              retry.relations,
              snapshot.revision,
              sentMarkers.deleted,
              sentMarkers.revived,
              snapshot.restoreGeneration,
            );
          }
          if (saveResponse.status === 409) {
            const again = (await saveResponse.json()) as ServerSnapshot;
            if (again.code === "restored" && restoredSinceKnown(again.restoreGeneration)) { await replaceLocalWithServer(again, true); return; }
          }
          if (!saveResponse.ok) throw new Error("Initial synchronization failed");
          snapshot = (await saveResponse.json()) as ServerSnapshot;
        }
        if (localDataVersion.current !== initializationVersion) {
          // Something was changed locally while the app was starting, so the server copy was not
          // taken over. The known revision must stay as it is: the server replaces its whole
          // content when the revision matches, and the local copy does not contain that content.
          // With the old revision the save is answered with a conflict and merged instead.
          if (!alreadySynchronized || hasPendingChanges) await replaceSyncBase(outgoing.entities, outgoing.relations).catch(() => undefined);
          await syncToServer();
          return;
        }
        // Another tab may have written meanwhile: then the copy is not replaced and the change is
        // sent instead (lib/tab-coordination.ts).
        try {
          if (!(await applySnapshot(snapshot, initializationVersion, { entities: localEntities, relations: localRelations }))) return;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "LOCAL_DATA_CHANGED") throw error;
          await syncToServer();
          return;
        }
        if (localDataVersion.current !== initializationVersion) return;
        localStorage.setItem("ai-executive-server-synced", "1");
        markSignedIn();
        clearSentMarkers(sentMarkers);
        setSyncStatus(offlineRecoveryIsHeld() ? "offline" : "synced");
      } catch {
        // If a sibling activated recovery during startup, even fallback seeding is forbidden.
        if (!offlineRecoveryIsHeld()) await ensureDefaultWorkspace().catch(() => undefined);
        await load().catch(() => undefined);
        setSyncStatus("offline");
      } finally {
        if (startupStoreRequest.current === storeRequest) startupStoreRequest.current = null;
      }
    }
    initialize();
  }, []);
  useEffect(() => {
    if (authState !== "unavailable") return;
    startupStoreRequest.current?.abort();
    // The start may already be waiting on a later request (a second fetch or a save): the data kept
    // in this browser is shown now rather than when that request gives up.
    void ensureDefaultWorkspace().then(load).catch(() => undefined);
  }, [authState]);

  // Signing out removes the local copy of the data. Unsent changes are sent first; if that is not
  // possible the user decides whether to drop them. Without the server nothing is removed, because
  // the session cookie cannot be cleared from here.
  async function logout() {
    if (logoutBusy) return;
    // Never end the server session before confirming this browser can perform
    // a serialized local purge. Otherwise a Web-Locks-less browser would claim
    // sign-out succeeded while leaving private data accessible on the device.
    if (offlineRecoveryIsHeld() || !offlineRecoveryWipeSupported()) {
      setLogoutError(tr("signOutFailed"));
      return;
    }
    setLogoutBusy(true);
    setLogoutError("");
    // Started offline: access is checked again first, so changes made meanwhile are sent if the
    // connection is back (without a confirmed session they could not be, and would be offered for
    // discarding). Still without access, sign-out is refused as before.
    if (authStateRef.current === "unavailable" && (await checkAccess(true)) !== "ready") {
      setLogoutError(tr("signOutOffline"));
      setLogoutBusy(false);
      return;
    }
    let leaving = false;
    let askedOthers = false;
    let heartbeat = 0;
    try {
      // Other open tabs save what is being typed there first, so it is sent below too. Until this
      // tab has finished, it tells them every few seconds that it is still signing out.
      askedOthers = true;
      heartbeat = window.setInterval(() => postToTabs({ type: "signing-out", from: tabId.current }), 5_000);
      const others = await askOtherTabsToSave(tabId.current);
      // Tabs that did not answer (asleep) may still hold typed text; their note in the device counts.
      const unsavedElsewhere = others.unsaved + otherOpenTexts(localStorage, pageId.current).length;
      if (unsavedElsewhere > 0 && !(await askConfirm({ title: tr("signOutOtherTabTitle"), message: tr("signOutOtherTab"), confirmLabel: tr("signOutDiscardAction"), danger: true }))) {
        postToTabs({ type: "sign-out-cancelled", from: tabId.current });
        return;
      }
      const result = await runSignOut({
        version: () => localDataVersion.current,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        drainSync: () => syncQueue.current,
        // A note text held only in memory (storage full) counts too, so it is never dropped without asking.
        hasUnsent: async () => (await hasUnsentChanges()) || Boolean(noteBodyDraftRef.current) || parkedNoteBodies.current.size > 0,
        // Notes drafts kept in the device go into the local copy first, so they are sent too.
        sync: async () => { await saveLeftoverDrafts(true); await syncToServer(); },
        // Both requests are bounded: a stalled connection ends in "no connection", not a sign-out
        // that never finishes.
        serverReachable: () => fetch("/api/auth/status", { cache: "no-store", signal: AbortSignal.timeout(8_000) }).then((response) => response.ok).catch(() => false),
        confirmDiscard: () => askConfirm({ title: tr("signOutDiscardTitle"), message: tr("signOutDiscard"), confirmLabel: tr("signOutDiscardAction"), danger: true }),
        // From here nothing may be edited and no pull or sync still in flight may write data back.
        block: () => { signedOut.current = true; document.body.inert = true; },
        unblock: () => { signedOut.current = false; document.body.inert = false; },
        endSession: () => fetch("/api/auth/logout", { method: "POST", signal: AbortSignal.timeout(10_000) }).then((response) => (response.ok ? "ok" : "failed") as "ok" | "failed", () => "offline" as const),
        // If the wipe cannot finish now it stays marked and is completed when the page starts again.
        wipe: () => clearLocalData(),
      });
      if (result !== "signed-out") {
        if (failedSignOutNeedsReload(result, document.body.inert)) {
          // Server logout completed, but private local data was not verified
          // removed. This page is inert; redirect to an actionable signed-out
          // or recovery view, never claim a successful local purge.
          try { sessionStorage.setItem(incompleteSignOutNoticeKey, "1"); } catch { /* optional warning */ }
          leaving = true;
          window.location.replace("/");
          return;
        }
        postToTabs({ type: "sign-out-cancelled", from: tabId.current });
        setLogoutError(tr(result === "writing" ? "signOutBusy" : result === "offline" ? "signOutOffline" : result === "kept" ? "signOutKept" : "signOutFailed"));
        return;
      }
      leaving = true;
      try { const channel = new BroadcastChannel(sessionChannel); channel.postMessage("signed-out"); channel.close(); } catch { /* not supported */ }
      // A full reload drops everything still held in memory.
      window.location.replace("/");
    } catch (error) {
      if (askedOthers) postToTabs({ type: "sign-out-cancelled", from: tabId.current });
      throw error;
    } finally {
      window.clearInterval(heartbeat);
      if (!leaving) setLogoutBusy(false);
    }
  }
  // The message is about a moment in time: drop it when the user moves on or the data is in sync again.
  useEffect(() => { setLogoutError(""); }, [view]);
  // Status lines shown in one language are not kept after the language changes. The loads whose
  // failure is reported in a status line run again, so a failure that still lasts is reported in
  // the new language rather than hidden.
  const statusLanguage = useRef(language);
  useEffect(() => {
    if (statusLanguage.current === language) return;
    statusLanguage.current = language;
    setCalendarStatus("");
    setAgentStatus("");
    setContextStatus("");
    setSubjectStatus("");
    setClaimStatus("");
    setContextInboxStatus("");
    setLogoutError("");
    if (authState !== "ready") return;
    const workspaceId = calendarWorkspaceSelection.current;
    loadDurableContext(workspaceId).catch(() => setContextStatus(tr("contextIsUnavailable")));
    loadContextClaims(workspaceId).catch(() => setClaimStatus(tr("structuredContextIsUnavailable")));
    loadStandaloneSubjects(workspaceId).catch(() => setSubjectStatus(tr("peopleAndOrganizationsAre")));
  }, [language]);
  useEffect(() => { if (syncStatus === "synced") setLogoutError(""); }, [syncStatus]);
  // Another tab signed out: its data must not stay on screen here or be written back locally.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(sessionChannel);
    channel.onmessage = (event) => { if (event.data === "signed-out") { signedOut.current = true; window.location.replace("/"); } };
    return () => channel.close();
  }, []);

  // Resolve requested project IDs only from locally available records within the
  // selected legacy scope. Target Area ACL/server authorization arrives separately in R3.
  // Notification ?task= links keep their historical compatibility behavior.
  useEffect(() => {
    if (deepLinkHandled.current || (authState !== "ready" && !offlineViewRef.current) ||
        (!items.length && syncStatus !== "synced" && syncStatus !== "offline")) return;
    // R3-FE-4a: with target details on, a typed address is never resolved against local legacy records.
    const targetTyped = targetTypedNow();
    const route = targetTyped ? null : targetFromSearch(window.location.search, addressableViews, startupView);
    let resolvedTypedTarget = false;
    if (route?.kind === "project") {
      const destination = resolveLegacyProjectLink(items, route.id, activeWorkspaceId);
      if (destination) {
        resolvedTypedTarget = true;
        if (destination.selectWorkspaceId) selectWorkspace(destination.selectWorkspaceId);
        setViewState("Projects");
        setOpenProjectId(destination.projectId);
      } else if (syncStatus !== "synced" && syncStatus !== "offline") {
        return; // Do not mistake an incomplete initial load for a missing project.
      }
    }
    if (route?.kind === "task" || route?.kind === "note") {
      const destination = resolveLegacyRecordLink(items, relations, route, activeWorkspaceId);
      if (destination) {
        resolvedTypedTarget = true;
        if (destination.selectWorkspaceId) {
          selectWorkspace(destination.selectWorkspaceId);
          pendingRecordRef.current = { ...route, workspaceId: destination.record.workspaceId };
        } else {
          void inspect(destination.record, { navigate: false });
        }
        setViewState(route.view);
        setOpenProjectId(destination.projectId);
      } else if (syncStatus !== "synced" && syncStatus !== "offline") {
        return;
      }
    }
    // Do not classify a missing typed target until the authenticated snapshot
    // has completed; incomplete local data is not evidence of inaccessibility.
    if (!targetTyped && requestsTypedRecord(window.location.search) && syncStatus !== "synced" && syncStatus !== "offline") return;
    setNavigationUnavailable(!targetTyped && showUnavailableLink(window.location.search, resolvedTypedTarget));
    const taskId = new URLSearchParams(window.location.search).get("task");
    if (taskId) {
      const task = items.find((item) => item.id === taskId);
      if (task && task.type !== "workspace") {
        selectWorkspace(task.workspaceId);
        void inspect(task, { navigate: false });
      } else if (authState !== "ready" || syncStatus !== "synced") {
        return;
      }
    }
    deepLinkHandled.current = true;
    setDeepLinkDone(true);
  }, [items, relations, authState, syncStatus, activeWorkspaceId, startupView]);

  // The address follows the view except while a project URL is active. Back/Forward and
  // reload preserve the requested target. A legacy notification ?task= ID is dropped
  // after handling. Nothing is recorded while signed out;
  // the offline view (started without a connection) shows the app, so it is recorded there too.
  const addressedView = useRef<string | null>(null);
  useEffect(() => {
    if (!addressReady || (authState !== "ready" && !offlineViewRef.current)) return;
    const hasRecordLink = new URLSearchParams(window.location.search).has("task");
    // Even an invalid/ambiguous typed link must survive until the initial
    // authenticated snapshot has been checked and the generic notice queued.
    if ((hasRecordLink || requestsTypedRecord(window.location.search)) && !deepLinkDone) return;
    const route = targetFromSearch(window.location.search, addressableViews, startupView);
    // Preserve a direct record URL while local records and the first server
    // synchronization are still loading. Do not publish a transient empty list.
    if (route && route.kind !== "view" && !deepLinkDone) return;
    if (route?.kind === "project" && view === "Projects" && route.id === openProjectId) {
      addressedView.current = view;
      return;
    }
    if ((route?.kind === "task" || route?.kind === "note") && route.view === view &&
        route.id === selected?.id && route.kind === selected.type &&
        (route.projectId ?? null) === openProjectId) {
      // The inspector has committed. It is now safe to release the pending
      // navigation marker without changing this copyable record URL.
      if (pendingRecordRef.current?.id === route.id &&
          pendingRecordRef.current.kind === route.kind) pendingRecordRef.current = null;
      addressedView.current = view;
      return;
    }
    const pending = pendingRecordRef.current;
    if ((route?.kind === "task" || route?.kind === "note") &&
        pending?.kind === route.kind && pending.id === route.id &&
        pending.view === route.view && pending.projectId === route.projectId &&
        pending.workspaceId === activeWorkspaceId && route.view === view &&
        (route.projectId ?? null) === openProjectId) {
      // The workspace is committed but inspect() has only scheduled setSelected.
      // Retain the typed URL during this render; the next render above confirms
      // the actual selection, including after browser Back across workspaces.
      addressedView.current = view;
      return;
    }
    const navigationView = mobileDesignV1Preview && mobilePlanPreviewActive && view === "Today"
      ? "MyPlanPreview" : view;
    // R3-FE-4a: a target detail address of the current view is kept as it is (the shell
    // opens it); once the view differs from it, the normal view address replaces it.
    if (holdTypedAddress({ enabled: targetDetailsRef.current, search: window.location.search,
      navigationView, targetViews: targetViewsRef.current })) { addressedView.current = navigationView; return; }
    // Even if the preview uses Today as its local initial data view,
    // explicit ?view=Today must remain distinct and reloadable.
    const navigationStart = mobileDesignV1Preview && view === "Today" ? "Home" : startupView;
    const update = addressUpdate({ currentSearch: window.location.search,
      view: navigationView, startView: navigationStart,
      navigated: addressedView.current !== null && addressedView.current !== navigationView });
    addressedView.current = navigationView;
    if (!update) return;
    const address = `${window.location.pathname}${update.search}`;
    try {
      if (update.mode === "push") window.history.pushState(null, "", address);
      else window.history.replaceState(null, "", address);
    } catch { /* browsers limit how often history may change; the view itself is unaffected */ }
  }, [addressReady, authState, deepLinkDone, view, startupView, openProjectId, selected?.id, mobilePlanPreviewActive]);
  useEffect(() => {
    const followAddress = () => {
      if (mobileDesignV1Preview) {
        // popstate exposes the *destination* history state. The departing
        // entry ID is saved separately so Back B→A resolves B, not A.
        const destinationFocusId = knownProjectFocusPosition(
          window.history.state, knownProjectFocusPositionsRef.current);
        pendingProjectFocusRef.current = projectFocusReturnForHistory(
          activeProjectFocusEntryRef.current, projectFocusEntriesRef.current,
          destinationFocusId, window.location.search);
        activeProjectFocusEntryRef.current = destinationFocusId;
      }
      const previewRoute = mobileDesignV1Preview &&
        (mobileV1IsPlanPreviewRoute(window.location.search) ||
          (targetDetailsRef.current && targetViewsRef.current.includes("MyPlanPreview") && isPlanDetailSearch(window.location.search)));
      const next = previewRoute ? "Today" :
        viewFromSearch(window.location.search, addressableViews) || localStorage.getItem("ai-executive-startup-view") || "Home";
      // Leaving a field commits what was typed in it, as closing the panel by hand would.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setMobilePlanPreviewActive(previewRoute);
      addressedView.current = previewRoute ? "MyPlanPreview" : next;
      const nextView = views.includes(next) || next === "Settings" ? next : "Home";
      setViewState(nextView);
      // Canonical list URLs always show the list: stale history.state is ignored.
      // Reuse startup's legacy scope resolver so a Back/Forward destination in
      // a different, still-known workspace can be restored safely. URL IDs
      // never grant access; UI-09 replaces this with server-authorized reads.
      // R3-FE-4a: a typed target address belongs to the target detail, not to legacy records.
      const targetTyped = targetTypedNow();
      const target = targetTyped ? null : targetFromSearch(window.location.search, addressableViews, nextView);
      const project = nextView === "Projects" && target?.kind === "project"
        ? resolveLegacyProjectLink(latestItemsRef.current, target.id, activeWorkspaceRef.current)
        : null;
      const record = resolveLegacyRecordLink(latestItemsRef.current, latestRelationsRef.current,
        target, activeWorkspaceRef.current);
      const destination = record ?? project;
      // A typed URL never discloses whether the record was deleted or its access
      // changed. Treat both outcomes identically and keep the safe list view.
      const unavailableTarget = !targetTyped && showUnavailableLink(window.location.search, Boolean(destination));
      setNavigationUnavailable(unavailableTarget);
      if (unavailableTarget) {
        // Back/Forward may keep the same list view, so the view-sync effect
        // need not rerun. Replace this history entry explicitly: a revoked or
        // missing record ID should not remain as the displayed page address.
        try {
          window.history.replaceState(null, "", `${window.location.pathname}${searchForView(nextView, startupView)}`);
        } catch { /* The safe list view remains usable if History API is blocked. */ }
      }
      // Nothing from the previous inspector should stay open while Back/Forward
      // resolves a new record; stale async context requests are invalidated.
      closeDetail();
      pendingRecordRef.current = null;
      if (destination?.selectWorkspaceId) {
        selectWorkspaceRef.current(destination.selectWorkspaceId);
        if (record && (target?.kind === "task" || target?.kind === "note"))
          pendingRecordRef.current = { ...target, workspaceId: record.record.workspaceId };
      }
      setOpenProjectId(record?.projectId ?? project?.projectId ?? null);
      if (record && !destination?.selectWorkspaceId)
        void inspectRef.current(record.record, { navigate: false });
      answerConfirm(false);
      setCapture(false);
      setAssistantOpen(false);
      setMoreOpen(false);
    };
    window.addEventListener("popstate", followAddress);
    return () => window.removeEventListener("popstate", followAddress);
  }, []);

  useEffect(() => {
    if (!capture && captureOpener.current) {
      captureOpener.current.focus();
      captureOpener.current = null;
    }
  }, [capture]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const updateClock = () => setCalendarFreshNow(Date.now());
    const nextExpiry = calendarSources
      .filter((source) => source.status === "ready" && source.lastSuccessAt !== null)
      .map((source) => Number(source.lastSuccessAt) + 30 * 60_000 + 1)
      .filter((expiry) => expiry > Date.now())
      .sort((a, b) => a - b)[0];
    const timer = nextExpiry ? window.setTimeout(updateClock, Math.max(1, nextExpiry - Date.now())) : null;
    window.addEventListener("focus", updateClock);
    document.addEventListener("visibilitychange", updateClock);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("focus", updateClock);
      document.removeEventListener("visibilitychange", updateClock);
    };
  }, [calendarSources]);

  useEffect(() => {
    if (!moreOpen) return;
    moreDialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      const destination = moreFocusDestinationRef.current;
      moreFocusDestinationRef.current = null;
      if (!destination) {
        moreTriggerRef.current?.focus();
        return;
      }
      // The destination view commits together with closing the dialog. Delay
      // focus until its heading exists, and reject a subsequent navigation.
      window.requestAnimationFrame(() => {
        if (mobileMoreExitFocus(destination, currentViewForMoreFocusRef.current,
          Boolean(moreDialogRef.current), window.matchMedia("(max-width: 700px)").matches) !== "destination") return;
        const heading = document.querySelector<HTMLElement>(".appPane .pageTitleRow h1");
        // A subsequent pointer/keyboard action owns its new focus; do not
        // steal it on the next animation frame after the sheet disappears.
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && activeElement.isConnected &&
            activeElement !== document.body && activeElement !== moreTriggerRef.current) return;
        if (!heading?.isConnected || !heading.getClientRects().length) return;
        // Opening More from a long, scrolled list can leave the destination
        // heading behind the sticky toolbar or below the viewport. Reveal the
        // heading *before* focusing it, accounting for both fixed UI bars.
        const toolbarBottom = document.querySelector<HTMLElement>(".appPane .topbar")
          ?.getBoundingClientRect().bottom ?? 0;
        const navTop = document.querySelector<HTMLElement>(".mobileNav")
          ?.getBoundingClientRect().top ?? window.innerHeight;
        const rect = heading.getBoundingClientRect();
        const delta = mobileMoreHeadingRevealDelta(rect.top, rect.bottom,
          Math.max(0, toolbarBottom) + 12, Math.min(window.innerHeight - 12, navTop - 12));
        if (delta !== 0) window.scrollBy({ top: delta, behavior: "instant" });
        heading.focus({ preventScroll: true });
      });
    };
  }, [moreOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (confirmResolver.current) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setView("Search");
        document.querySelector<HTMLInputElement>(".searchField input")?.focus();
      } else if (event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setAssistantOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z undo and redo in Context, but only outside text fields: there they
  // keep the browser's own undo for what is being typed.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "z" || event.defaultPrevented) return;
      if (!contextShortcut.current.active || confirmResolver.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") || (target as HTMLElement | null)?.isContentEditable) return;
      event.preventDefault();
      contextShortcut.current.run(event.shiftKey ? "redo" : "undo");
    };
    // Another tab or device may have changed the history while this page was in the background.
    const onFocus = () => { if (contextShortcut.current.active) loadContextHistory().catch(() => undefined); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("focus", onFocus); };
  }, []);

  useEffect(() => {
    const savedTheme = localStorage.getItem("ai-executive-theme");
    if (savedTheme === "system" || savedTheme === "light" || savedTheme === "dark") {
      setThemeMode(savedTheme);
    }
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = themeMode === "system" ? (media.matches ? "dark" : "light") : themeMode;
      setResolvedTheme(resolved);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.setAttribute("content", resolved === "dark" ? "#1c1c1e" : "#ffffff");
    };
    applyTheme();
    if (themeMode === "system") media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themeMode, themeReady]);

  useEffect(() => {
    // Settings can now be the first view (from the address), also before sign-in: load only
    // with a session, and never store an error body as settings.
    if (view !== "Settings" || authState !== "ready") return;
    const json = (response: Response) => response.ok ? response.json() : Promise.reject(new Error("unavailable"));
    Promise.all([
      fetch("/api/backups", { cache: "no-store" }).then(json),
      fetch("/api/notifications", { cache: "no-store" }).then(json),
    ])
      .then(([backupData, notificationData]) => {
        setBackups(Array.isArray(backupData.backups) ? backupData.backups : []);
        setNotificationState(notificationData as NotificationState);
      })
      .catch(() => setBackupStatus(tr("serverSettingsOffline")));
    // Also after a language change: the status was cleared, and a failure is reported again.
  }, [view, authState, language]);

  // Access became known only now (the app was opened without a connection, or the check was
  // repeated): what waits on this device is sent and the server copy taken, without waiting for
  // the window to be focused again. (A fresh sign-in does this itself.)
  const accessWasUnavailable = useRef(false);
  useEffect(() => {
    if (authState === "unavailable") accessWasUnavailable.current = true;
    if (authState === "ready" && accessWasUnavailable.current) {
      accessWasUnavailable.current = false;
      void pullFromServer();
    }
    if (authState === "required") accessWasUnavailable.current = false;
  }, [authState]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (authStateRef.current === "ready") { pullFromServer(); return; }
      // On the sign-in screen no data is requested (the server would count each refusal). If the
      // session ended here but another tab has signed in since, this one continues without asking.
      if (authStateRef.current === "required" && sessionEndedHere.current) {
        fetchClientAuthStatus().then((state) => {
          if (!state.authenticated || authStateRef.current !== "required") return;
          setAuthState("ready");
          void pullFromServer();
        }).catch(() => undefined);
      }
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  useEffect(() => {
    const workspaceId =
      activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    const workspace = items.find(
      (entity) =>
        entity.type === "workspace" && entity.workspaceId === workspaceId,
    );
    const validWriteWorkspace = items.some(
      (entity) =>
        entity.type === "workspace" && entity.workspaceId === writeWorkspaceId,
    );
    if (items.some((entity) => entity.type === "workspace") && !validWriteWorkspace) {
      assistantRequestVersion.current += 1;
      setMessages([]);
      setAiText("");
      setAiBusy(false);
      closeDetail();
      setWriteWorkspaceId(personalWorkspaceId);
      localStorage.setItem(
        "ai-executive-write-workspace",
        personalWorkspaceId,
      );
      return;
    }
    if (workspace) {
      // A name being edited is kept when only the language changes; it is replaced when another
      // workspace is shown or when the field still holds the previously shown name.
      const shown = workspaceTitle(workspace);
      const previous = shownWorkspaceName.current;
      setWorkspaceDraft((draft) => previous.id !== workspace.id || draft === previous.title ? shown : draft);
      shownWorkspaceName.current = { id: workspace.id, title: shown };
    }
  }, [activeWorkspaceId, items, writeWorkspaceId, language]);

  // Closing the sheet preserves a typed draft until the app is reloaded. Sign-out
  // discards all in-memory drafts together with the rest of the session.
  useEffect(() => {
    if (capture) captureDrafts.current.set(captureDraftKey.current, draft);
  }, [capture, draft]);

  // The suggestion for Quick Capture depends on the text and where the task goes, not on every
  // reload of the local copy: a reload (a save, another tab, another device) must not restart it,
  // which would disable the add button for a moment and could swallow a click on it.
  const captureItemsRef = useRef(items);
  captureItemsRef.current = items;
  const captureProjectWorkspaceId = (captureProjectId && items.find((item) => item.id === captureProjectId)?.workspaceId) || "";
  // A prior approval cannot be reused if the user switches away from a shared
  // target and then returns, including when the AI suggestion changes the project.
  useEffect(() => {
    setCaptureSharedConsentKey("");
  }, [captureType, captureWriteWorkspaceId, captureProjectId, captureAreaId,
      captureProjectAction, captureSuggestion?.projectId,
      captureSuggestion?.newProjectSuggestion?.title, useCaptureSuggestion]);
  // Without access to the server (an offline start) there is no suggestion to wait for: asking would
  // only keep the add button disabled until the request is given up.
  const captureServerUnavailable = authState === "unavailable";
  useEffect(() => {
    const parsed = parseCapture(draft);
    if (!capture || captureType !== "task" || parsed.title.length < 3 || captureServerUnavailable) {
      captureSuggestionVersion.current += 1;
      setCaptureSuggestion(null);
      setCaptureSuggestionBusy(false);
      setCaptureSuggestionError("");
      return;
    }
    const version = ++captureSuggestionVersion.current;
    // A task added to a project goes to the project's workspace; its suggestions (area, calendar
    // window) have to come from there too.
    const workspaceId = captureProjectWorkspaceId || captureWriteWorkspaceId;
    setCaptureSuggestion(null);
    setCaptureSuggestionBusy(true);
    setCaptureSuggestionError("");
    const controller = new AbortController();
    const abortTimer = window.setTimeout(() => controller.abort(), 7000);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/task-suggestions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: parsed.title,
            workspaceId,
            requestedDate: parsed.when || undefined,
            explicitPriority: parsed.priority,
            language,
          }),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(localizeServerError(body.error, tr) || tr("suggestionFailed"));
        if (captureSuggestionVersion.current !== version) return;
        const suggestion = body.suggestion as CaptureSuggestion;
        suggestion.newProjectSuggestion = suggestion.newProjectSuggestion || null;
        suggestion.scheduledOptions = Array.isArray(suggestion.scheduledOptions)
          ? suggestion.scheduledOptions
          : suggestion.scheduledStart
            ? [{ start: suggestion.scheduledStart, end: suggestion.scheduledEnd, date: suggestion.scheduledDate }]
            : [];
        if (captureProjectId) {
          const project = captureItemsRef.current.find((item) => item.id === captureProjectId && item.type === "project");
          suggestion.projectId = captureProjectId;
          suggestion.projectTitle = project?.title || suggestion.projectTitle;
        }
        if (!captureAreaTouched.current) setCaptureAreaId(suggestion.areaId || "");
        setCaptureProjectAction(captureProjectId
          ? "existing"
          : suggestion.newProjectSuggestion
            ? ""
            : suggestion.projectId
              ? "existing"
              : "none");
        setCaptureSuggestion(suggestion);
      } catch (error) {
        if (captureSuggestionVersion.current === version) {
          setCaptureSuggestion(null);
          // Without a connection there is simply no suggestion; the task can still be added, so
          // this is not shown as an error.
          // A request that did not reach the server, or stalled until it was given up (the server is
          // unreachable), means no connection, not a failed suggestion.
          const unreachable = error instanceof TypeError || (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError"));
          setCaptureSuggestionError(unreachable ? "" : tr("suggestionUnavailable"));
        }
      } finally {
        window.clearTimeout(abortTimer);
        if (captureSuggestionVersion.current === version) setCaptureSuggestionBusy(false);
      }
    }, 650);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(abortTimer);
      controller.abort();
    };
  }, [capture, captureType, draft, activeWorkspaceId, captureWriteWorkspaceId, captureProjectId, captureProjectWorkspaceId, language, captureServerUnavailable]);

  async function saveWorkspaceName() {
    // R3-FE-4a: no target API for this legacy action yet; unified mode keeps it inert.
    if (blockLegacyWrite()) return;
    const name = workspaceDraft.trim();
    if (!name || name.length > 120) return;
    const workspaceId =
      activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    const workspace = items.find(
      (entity) =>
        entity.type === "workspace" && entity.workspaceId === workspaceId,
    );
    if (!workspace) return;
    // Saving the name as it is shown changes nothing (the personal workspace is shown translated
    // while it keeps its stored name).
    if (name === workspaceTitle(workspace)) {
      setSettingsSaved(true);
      window.setTimeout(() => setSettingsSaved(false), 1800);
      return;
    }
    localDataVersion.current += 1;
    await db.entities.update(workspace.id, {
      title: name,
      updatedAt: writeTime(),
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    setSettingsSaved(true);
    window.setTimeout(() => setSettingsSaved(false), 1800);
  }

  function saveLanguage(nextLanguage: Language) {
    setLanguage(nextLanguage);
    localStorage.setItem("ai-executive-language", nextLanguage);
  }

  function saveTheme(nextTheme: ThemeMode) {
    setThemeReady(true);
    setThemeMode(nextTheme);
    localStorage.setItem("ai-executive-theme", nextTheme);
  }

  function selectWorkspace(workspaceId: string) {
    pendingRecordRef.current = null;
    assistantRequestVersion.current += 1;
    setActiveWorkspaceId(workspaceId);
    if (workspaceId !== "all") selectWriteWorkspace(workspaceId);
    localStorage.setItem("ai-executive-active-workspace", workspaceId);
    setMessages([]);
    setAiText("");
    setAiBusy(false);
    setWorkspaceMenuOpen(false);
    closeDetail();
  }
  // The browser history handler must use today's selection callback rather
  // than one closed over by its mount-only listener.
  selectWorkspaceRef.current = selectWorkspace;

  function selectWriteWorkspace(workspaceId: string) {
    if (workspaceId !== writeWorkspaceId) {
      assistantRequestVersion.current += 1;
      setMessages([]);
      setAiText("");
      setAiBusy(false);
      closeDetail();
    }
    setWriteWorkspaceId(workspaceId);
    localStorage.setItem("ai-executive-write-workspace", workspaceId);
  }

  // A manual area choice in quick capture; a later suggestion no longer replaces it.
  function chooseCaptureArea(areaId: string) {
    captureAreaTouched.current = true;
    setCaptureSharedConsentKey("");
    setCaptureAreaId(areaId);
  }
  function captureKey(type: "task" | "note", workspaceId: string, projectId = "") {
    return `${type}:${workspaceId}:${projectId}`;
  }
  function replaceCaptureScope(type: "task" | "note", workspaceId: string, projectId = "") {
    if (capture) captureDrafts.current.set(captureDraftKey.current, draft);
    const key = captureKey(type, workspaceId, projectId);
    captureDraftKey.current = key;
    setDraft(captureDrafts.current.get(key) || "");
  }
  function editCaptureDraft(value: string) {
    const key = captureDraftKey.current;
    captureDraftRevisions.current.set(key, (captureDraftRevisions.current.get(key) ?? 0) + 1);
    // Store on input, not in a later effect: an old save may finish between
    // the change event and React's next effect flush.
    captureDrafts.current.set(key, value);
    setDraft(value);
  }
  function chooseCaptureType(type: "task" | "note") {
    if (type === captureType || captureProjectId) return;
    replaceCaptureScope(type, captureWriteWorkspaceId);
    setCaptureSharedConsentKey("");
    setCaptureType(type);
    setCaptureAreaId("");
    captureAreaTouched.current = false;
    setCaptureSuggestion(null);
    setCaptureSuggestionError("");
    setCaptureProjectAction("none");
  }
  function discardCaptureDraft() {
    const key = captureDraftKey.current;
    captureDraftRevisions.current.set(key, (captureDraftRevisions.current.get(key) ?? 0) + 1);
    captureDrafts.current.delete(key);
    setDraft("");
    setCaptureSuggestion(null);
    setCaptureSuggestionError("");
    setCaptureProjectAction(captureProjectId ? "existing" : "none");
  }
  function selectCaptureWriteWorkspace(workspaceId: string) {
    if (workspaceId === captureWriteWorkspaceId || !workspaces.some((workspace) => workspace.workspaceId === workspaceId)) return;
    replaceCaptureScope(captureType, workspaceId);
    setCaptureSharedConsentKey("");
    // A manual choice belongs to the prior workspace. New suggestions may now fill the area.
    setCaptureAreaId("");
    captureAreaTouched.current = false;
    captureSuggestionVersion.current += 1;
    setCaptureSuggestion(null);
    setCaptureProjectAction("none");
    setCaptureWriteWorkspaceId(workspaceId);
  }

  async function createWorkspace() {
    // R3-FE-4a: no target API for this legacy action yet; unified mode keeps it inert.
    if (blockLegacyWrite()) return;
    const name = newWorkspaceDraft.trim();
    if (!name || name.length > 120) return;
    const workspaceId = crypto.randomUUID();
    const now = writeTime();
    localDataVersion.current += 1;
    await db.entities.add({
      id: `workspace:${workspaceId}`,
      type: "workspace",
      title: name,
      status: "active",
      workspaceId,
      properties: {
        kind: "shared",
        role: "owner",
        members: [{ id: "owner", role: "owner" }],
      },
      createdAt: now,
      updatedAt: now,
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    setNewWorkspaceDraft("");
    selectWorkspace(workspaceId);
  }
  // The personal workspace is created with the name "Personal"; until it is renamed it is shown in
  // the interface language.
  const shownWorkspaceName = useRef({ id: "", title: "" });
  const workspaceTitle = (workspace: Entity) =>
    workspace.workspaceId === personalWorkspaceId && workspace.title === "Personal" ? tr("personalWorkspace") : workspace.title;
  const workspaces = items
      .filter((entity) => entity.type === "workspace")
      .map((workspace) => ({ ...workspace, title: workspaceTitle(workspace) }))
      .sort((a, b) =>
        a.workspaceId === personalWorkspaceId
          ? -1
          : b.workspaceId === personalWorkspaceId
            ? 1
            : a.title.localeCompare(b.title),
      ),
    activeWorkspace = workspaces.find(
      (workspace) => workspace.workspaceId === activeWorkspaceId,
    ),
    writeWorkspace = workspaces.find(
      (workspace) => workspace.workspaceId === writeWorkspaceId,
    ) || workspaces[0],
    workspaceName =
      activeWorkspaceId === "all"
        ? tr("allWork")
        : activeWorkspace?.title || tr("personalWorkspace"),
    scopedItems = items.filter(
      (entity) =>
        entity.type !== "workspace" &&
        (activeWorkspaceId === "all" ||
          entity.workspaceId === activeWorkspaceId),
    ),
    scopedRelations = relations.filter(
      (relation) =>
        activeWorkspaceId === "all" ||
        relation.workspaceId === activeWorkspaceId,
    ),
    tasks = scopedItems.filter((x) => x.type === "task"),
    projects = scopedItems.filter((x) => x.type === "project"),
    areas = scopedItems.filter((x) => x.type === "area"),
    today = ymd();
  visibleProjectsRef.current = projects;
  const openProject = openProjectId ? projects.find((project) => project.id === openProjectId) ?? null : null;
  // The page closes when its project is gone (deleted elsewhere) or out of the open workspace.
  useEffect(() => { if (openProjectId && !openProject) setOpenProjectId(null); }, [openProjectId, openProject]);
  const sidebarCounts: Record<string, number> = {
    Inbox: tasks.filter((task) => taskMatchesView(task, "Inbox", today)).length,
    Today: tasks.filter((task) => taskMatchesView(task, "Today", today)).length,
    Overdue: tasks.filter((task) => taskMatchesView(task, "Overdue", today)).length,
    Upcoming: tasks.filter((task) => taskMatchesView(task, "Upcoming", today)).length,
    Anytime: tasks.filter((task) => taskMatchesView(task, "Anytime", today)).length,
    Someday: tasks.filter((task) => taskMatchesView(task, "Someday", today)).length,
    Completed: tasks.filter((task) => taskMatchesView(task, "Completed", today)).length,
    Projects: projects.length,
    Areas: areas.length,
    Notes: scopedItems.filter((entity) => entity.type === "note").length,
  };
  // The sidebar shows counts for Inbox and Today only; Projects gets a dot when a project needs attention.
  const projectsAttention = projectsNeedAttention(scopedItems, projects, scopedRelations, today);
  // UI-03a: the v1 desktop sidebar is a complete project navigation list,
  // not the legacy seven-project shortcut. Scope filtering remains in the
  // existing pure helper; aggregate does not infer new permissions.
  const sidebarProjects = activeSidebarProjects(
    projects, activeWorkspaceId, mobileDesignV1Preview ? Number.POSITIVE_INFINITY : undefined,
  );
  // Leaving the Inbox returns it to its tasks, so the sidebar entry always opens the task list.
  useEffect(() => { if (view !== "Inbox") setInboxTab("tasks"); }, [view]);
  useEffect(() => { setLegacyWriteAttempt(false); }, [view]);
  // A message to open belongs to the mail tab only; it is dropped when that tab is not shown.
  useEffect(() => { if (view !== "Inbox" || inboxTab !== "mail") setMailSourceToOpen(null); }, [view, inboxTab]);
  const projectGroups = view === "Projects" ? groupProjectsByArea(projects, areas, scopedRelations) : [];
  const { notificationState, setNotificationState, notificationStatus, enableNotifications, disableNotifications,
    testNotification, saveNotificationSettings } = useNotifications({ tr, language, writesBlocked: blockLegacyWrite });
  const calendarTimezone = notificationState?.preferences.timezone || "Europe/Prague";
  const calendarToday = useMemo(() => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: calendarTimezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(badgeNow)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }, [badgeNow, calendarTimezone]);
  const dayPlanState = useDayPlan({ writesBlocked: blockLegacyWrite, authState, activeWorkspaceId, writeWorkspaceId, items, language, tr, calendarToday,
    calendarWorkspaceSelection, askConfirm, closeDetail, pullFromServer, selectWorkspace, syncQueue, pendingKey });
  const { applyDayPlanAction, currentDayPlanBlock, dayPlanBusy, dayPlanNow, dayPlanStatus, dayPlanTimeline, dayPlanUndo, dayPlanWhy, loadDayPlan, nextDayPlanBlock, setDayPlanNow, setDayPlanStatus, undoDayPlanBlock, visibleDayPlan, workElapsedText, workOverrun, workSession, workSessionAction, workSessionBusy, workSessionStatus } = dayPlanState;
  const { passkeys, passkeyLabel, setPasskeyLabel, passkeyPassword, setPasskeyPassword, passkeyStatus, registerPasskey,
    removePasskey } = usePasskeys({ view, authState, tr, language, askConfirm, setPasskeyBusy });
  const { backups, setBackups, backupStatus, setBackupStatus, backupBusy, backupFailed, createServerBackup, restoreServerBackup, downloadExport, importExport } = useBackups({
    writesBlocked: blockLegacyWrite, language, tr, askConfirm, replaceLocal: replaceLocalWithServer });
  // After the reload that ended an adoption of restored data: the success message of the action that ran it, or the notice
  // that the restore happened elsewhere. (Applied once the app is ready, after the language has settled.)
  useEffect(() => {
    if (authState !== "ready") return;
    const kind = takeAfterRestoreFlag();
    if (!kind) return;
    if (kind === "restore" || kind === "import") {
      setSettingsSection("data");
      setBackupStatus(tr(kind === "restore" ? "backupRestored" : "backupImported"));
    } else showRestoredNotice();
  }, [authState]);
  // Started without a connection (owner decision 2026-10-09): access could not be checked, but this
  // browser has synchronized with the server before and still holds its data (signing out removes
  // it), so the app shows that data, marked as offline, instead of only the access screen. Access is
  // checked again in the background; if the server then says the session has ended, the sign-in
  // screen replaces the app, and nothing typed meanwhile is lost (it waits to be sent).
  // Whether this browser is signed in is kept as its own mark, not guessed from the records: an
  // account may have none (everything deleted). A browser signed in before this mark existed
  // counts if it has synchronized and holds records.
  const offlineView = authState === "unavailable" && (() => {
    try {
      if (localStorage.getItem("ai-executive-wipe-pending") === "1") return false;
      if (localStorage.getItem(signedOutKey) === "1") return false;
      if (localStorage.getItem(signedInKey) === "1") return true;
      return localStorage.getItem("ai-executive-server-synced") === "1" && items.some((entity) => entity.type !== "workspace");
    } catch { return false; }
  })();
  offlineViewRef.current = offlineView;
  // "Try again" in the offline banner: a check that still finds no connection says so for a moment.
  const [offlineRetry, setOfflineRetry] = useState<"" | "checking" | "failed">("");
  async function retryAccess() {
    setOfflineRetry("checking");
    // The result of this check, not the last rendered state (the screen may not have updated yet).
    const result = await checkAccess(true);
    setOfflineRetry(result === "unavailable" ? "failed" : "");
    window.setTimeout(() => setOfflineRetry((state) => (state === "failed" ? "" : state)), 4_000);
  }
  const attentionState = useAttention({ writesBlocked: blockLegacyWrite, authState, offlineView, activeWorkspaceId, syncStatus, items, pendingDeletedIds, tr, language, signingOut: () => signedOut.current || document.body.inert });
  const calendarTomorrowDate = new Date(`${calendarToday}T12:00:00Z`);
  calendarTomorrowDate.setUTCDate(calendarTomorrowDate.getUTCDate() + 1);
  const calendarTomorrow = calendarTomorrowDate.toISOString().slice(0, 10);
  const attentionTaskCount = items.filter((task) => {
    if (task.type !== "task" || task.status !== "open") return false;
    return [task.properties.when, task.properties.deadline].some(
      (due) => typeof due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(due) && due <= calendarTomorrow,
    );
  }).length;
  const { badgeStatus, testAppBadge, restoreAppBadge } = useAppBadge({ authState, notificationState, attentionTaskCount,
    calendarTomorrow, calendarTimezone, setBadgeNow, standalone, tr });
  const dayStart = Date.parse(zonedDateTimeToIso(calendarToday, notificationState?.preferences.workdayStart || "08:00", calendarTimezone));
  const dayEnd = Date.parse(zonedDateTimeToIso(calendarToday, notificationState?.preferences.workdayEnd || "18:00", calendarTimezone));
  // Keep the workday slice for capacity calculations, but give Calendar its own
  // complete local-day slice. A morning or evening commitment must not disappear
  // merely because it falls outside the configured working interval.
  // Hidden events leave the lists but keep occupying time: capacity, free windows and conflicts use all events.
  const busyTodayCalendarEvents = calendarEvents.filter((event) => Date.parse(event.end) > dayStart && Date.parse(event.start) < dayEnd);
  const [calendarTodayRange, calendarNearTermRange] = useMemo(() => [
    calendarLocalDayRange(calendarToday, 1, calendarTimezone),
    calendarLocalDayRange(addCalendarDays(calendarToday, 1), 7, calendarTimezone),
  ], [calendarToday, calendarTimezone]);
  const calendarDayEventsAll = useMemo(() => calendarEvents.filter((event) =>
    calendarEventOverlapsLocalRange(event, calendarTodayRange)), [calendarEvents, calendarTodayRange]);
  const calendarFresh = calendarSources.length > 0 && calendarSources.every((source) =>
    source.status === "ready" && source.lastSuccessAt !== null &&
    calendarFreshNow >= source.lastSuccessAt && calendarFreshNow - source.lastSuccessAt <= 30 * 60_000,
  );
  const nearbyCalendarEventsAll = useMemo(() => calendarEvents
    .filter((event) => calendarEventOverlapsLocalRange(event, calendarNearTermRange))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)), [calendarEvents, calendarNearTermRange]);
  const calendarEventsState = useCalendarEvents({
    writesBlocked: blockLegacyWrite, items, calendarEvents, calendarFresh, calendarTimezone, today, activeWorkspaceId, calendarWorkspaceSelection,
    workdayStart: notificationState?.preferences.workdayStart || "08:00", workdayEnd: notificationState?.preferences.workdayEnd || "18:00",
    localDataVersion, syncToServer, load, setUndo, setUndoRelations, undoCreated, undoDecisions, create, deferTask,
  });
  const { agendaCalendarEvents, effectiveBusyCalendarEvents } = calendarEventsState;
  // Agendas (Today, Home) leave out hidden and converted events; the Calendar view lists everything.
  const todayCalendarEvents = agendaCalendarEvents(busyTodayCalendarEvents);
  const calendarDayEvents = useMemo(() => agendaCalendarEvents(calendarDayEventsAll), [agendaCalendarEvents, calendarDayEventsAll]);
  const nearbyCalendarEvents = agendaCalendarEvents(nearbyCalendarEventsAll);
  // Busy time, free hours/windows and conflicts: hidden events and events that became tasks do not occupy time.
  const busyCalendarDayEvents = useMemo(() => effectiveBusyCalendarEvents(calendarDayEventsAll), [effectiveBusyCalendarEvents, calendarDayEventsAll]);
  // Tasks made from today's events that Today shows on its day timeline instead of in its list: open,
  // linked to an event of today, and a Today task (a task deferred away leaves Today altogether).
  const todayTimelineTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const event of calendarDayEventsAll) {
      const linked = calendarEventsState.calendarEventTasks.get(event.id);
      if (!linked || linked.status !== "open" || !taskMatchesView(linked, "Today", today)) continue;
      // The task's own span (its estimate from the event's start) must reach into today, or it would be
      // on neither the timeline nor the list.
      const span = eventTaskSpan(event, linked);
      if (Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > calendarTodayRange.start && span.start < calendarTodayRange.end) ids.add(linked.id);
    }
    return ids;
  }, [calendarDayEventsAll, calendarEventsState.calendarEventTasks, today, calendarTodayRange]);
  const mergedBusy = effectiveBusyCalendarEvents(busyTodayCalendarEvents).map((event) => [
    Math.max(dayStart, Date.parse(event.start)), Math.min(dayEnd, Date.parse(event.end)),
  ] as [number, number]).sort((a, b) => a[0] - b[0]).reduce<Array<[number, number]>>((merged, interval) => {
    const last = merged[merged.length - 1];
    if (!last || interval[0] > last[1]) merged.push(interval);
    else last[1] = Math.max(last[1], interval[1]);
    return merged;
  }, []);
  const freeHours = Math.max(0, (dayEnd - dayStart - mergedBusy.reduce((total, interval) => total + interval[1] - interval[0], 0)) / 3_600_000);
  const freeWindows = (() => {
    const result: Array<[number, number]> = [];
    let cursor = dayStart;
    for (const interval of mergedBusy) {
      if (interval[0] - cursor >= 30 * 60_000) result.push([cursor, interval[0]]);
      cursor = Math.max(cursor, interval[1]);
    }
    if (dayEnd - cursor >= 30 * 60_000) result.push([cursor, dayEnd]);
    return result;
  })();
  const targets = (sourceId: string, type: string) =>
    scopedRelations
      .filter((r) => r.sourceEntityId === sourceId && r.relationType === type)
      .map((r) => r.targetEntityId);
  const sources = (targetId: string, type: string) =>
    scopedRelations
      .filter((r) => r.targetEntityId === targetId && r.relationType === type)
      .map((r) => r.sourceEntityId);
  // Home's Today lists only tasks that are not the subject of an attention item shown above it
  // (the first five, or all when the list is expanded); its counts come from the same set.
  const todayTasks = tasks.filter((task) => taskMatchesView(task, "Today", today)).sort(byManualOrder("task:Today"));
  const homeToday = homeTodayList({
    todayTasks,
    attentionItems: (attentionState.visibleAttention?.items ?? []).slice(0, attentionState.showAllAttention ? undefined : 5),
    limit: 5,
  });
  const homeTodayTasks = homeToday.shown;
  const visible = useMemo(
    () => {
      const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
      return tasks.filter((t) => {
        if (priorityFilter !== "all" && String(t.properties.priority || "none") !== priorityFilter) return false;
        return taskMatchesView(t, view, today);
      }).sort((a, b) => {
        if (sortBy === "manual") return byManualOrder(`task:${view}`)(a, b);
        if (sortBy === "created") return b.createdAt - a.createdAt;
        if (sortBy === "priority") {
          return (priorityRank[String(a.properties.priority || "none")] ?? 3) -
            (priorityRank[String(b.properties.priority || "none")] ?? 3);
        }
        return taskDateSortKey(a, view).localeCompare(taskDateSortKey(b, view));
      });
    },
    [tasks, view, today, sortBy, priorityFilter],
  );
  function parseCapture(raw: string) {
    return parseCaptureText(raw, today);
  }
  async function create(
    type: EntityType,
    title: string,
    extra: Record<string, unknown> = {},
    onLocalCommit?: () => void,
  ) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    if (!title.trim()) return;
    const now = writeTime(),
      id = typeof extra.entityId === "string" ? extra.entityId : crypto.randomUUID(),
      projectId = typeof extra.projectId === "string" ? extra.projectId : "",
      areaId = typeof extra.areaId === "string" ? extra.areaId : "",
      newProjectTitle = typeof extra.newProjectTitle === "string" ? extra.newProjectTitle.trim() : "",
      properties = { ...extra },
      // A user-approved title imported from another source is literal, not
      // Quick Capture syntax. E.g. "Podklady zítra 25.10. #high" is a subject
      // line, not an instruction to change the title, due date or priority.
      parsed =
        type === "task" && extra.literalTaskTitle !== true
          ? parseCapture(title)
          : { title: title.trim(), when: "", priority: "none" };
    const linkedProject = projectId ? await db.entities.get(projectId) : null;
    const linkedArea = areaId ? await db.entities.get(areaId) : null;
    if (projectId && (!linkedProject || !projectAcceptsNewItems(linkedProject))) {
      throw new Error("The selected project is invalid");
    }
    if (areaId && (!linkedArea || linkedArea.type !== "area" || linkedArea.status !== "active")) {
      throw new Error("The selected area is invalid");
    }
    if (newProjectTitle && (type !== "task" || projectId || newProjectTitle.length > 120)) {
      throw new Error("The proposed project is invalid");
    }
    const explicitWorkspaceId =
      typeof extra.workspaceId === "string" ? extra.workspaceId : "";
    const creationWorkspaceId =
      linkedProject?.workspaceId ||
      linkedArea?.workspaceId ||
      explicitWorkspaceId ||
      writeWorkspaceId;
    let workspace = await db.entities.get(`workspace:${creationWorkspaceId}`);
    // Something typed right after the app opens can come before the local copy exists. The
    // personal workspace always exists on the server, so its placeholder (which never wins a
    // merge) is created here instead of refusing the item.
    if (!workspace && creationWorkspaceId === personalWorkspaceId) {
      await ensureDefaultWorkspace();
      workspace = await db.entities.get(`workspace:${creationWorkspaceId}`);
    }
    if (!workspace || workspace.type !== "workspace") {
      throw new Error("A valid write workspace is required");
    }
    if (
      (linkedProject && linkedProject.workspaceId !== creationWorkspaceId) ||
      (linkedArea && linkedArea.workspaceId !== creationWorkspaceId)
    ) {
      throw new Error("Cross-workspace relations are not allowed");
    }
    delete properties.projectId;
    delete properties.areaId;
    delete properties.entityId;
    delete properties.workspaceId;
    delete properties.newProjectTitle;
    // A creation-time control flag must not become canonical task metadata.
    delete properties.literalTaskTitle;
    // 2a part 4: an Area always carries the visibility of its workspace.
    if (type === "area") {
      const kind = await areaKindOf(creationWorkspaceId);
      if (kind) properties.kind = kind;
    }
    localDataVersion.current += 1;
    let created = false;
    try {
    await db.transaction("rw", db.entities, db.relations, async () => {
      if (await db.entities.get(id)) return;
      if (newProjectTitle) {
        const duplicate = findActiveProjectWithTitle(await db.entities.toArray(), creationWorkspaceId, newProjectTitle);
        if (duplicate) throw new Error("PROJECT_ALREADY_EXISTS");
      }
      const createdProjectId = newProjectTitle ? crypto.randomUUID() : "";
      if (createdProjectId) {
        const createdProject: Entity = {
          id: createdProjectId,
          type: "project",
          title: newProjectTitle,
          status: "active",
          workspaceId: creationWorkspaceId,
          properties: {},
          createdAt: now,
          updatedAt: now,
        };
        await db.entities.add(createdProject);
        // A project has exactly one Area: the chosen one, otherwise the workspace's fallback.
        if (areaId) {
          await db.relations.add({
            id: crypto.randomUUID(),
            workspaceId: creationWorkspaceId,
            sourceEntityId: createdProjectId,
            targetEntityId: areaId,
            relationType: "belongs_to_area",
            createdAt: now,
          });
        } else {
          await assignFallbackArea(createdProject, now);
        }
      }
      const createdEntity: Entity = {
        id,
        type,
        title: parsed.title,
        status: type === "task" ? "open" : "active",
        workspaceId: creationWorkspaceId,
        properties:
          type === "task"
            ? {
                ...properties,
                ...newTaskPlacement(parsed.when, properties, { view, today, hasProject: Boolean(projectId || newProjectTitle) }),
                ...(parsed.priority !== "none" ? { priority: parsed.priority } : {}),
                activity: [{ at: now, action: "created" }],
              }
            : properties,
        createdAt: now,
        updatedAt: now,
      };
      await db.entities.add(createdEntity);
      created = true;
      const inProject = Boolean(projectId || createdProjectId);
      if (inProject) {
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: creationWorkspaceId,
          sourceEntityId: id,
          targetEntityId: projectId || createdProjectId,
          relationType: "belongs_to_project",
          createdAt: now,
        });
      }
      // A task in a project has no Area of its own (it inherits the project's), so a chosen Area is not stored for it.
      const ownArea = Boolean(areaId) && !(type === "task" && inProject);
      if (ownArea) {
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: creationWorkspaceId,
          sourceEntityId: id,
          targetEntityId: areaId,
          relationType: "belongs_to_area",
          createdAt: now,
        });
      } else if (!inProject) {
        // A project or standalone task without a chosen Area gets the fallback Area (no-op for other types).
        await assignFallbackArea(createdEntity, now);
      }
    });
        } finally {
      // Also when the write is refused: an odd version means "a write is in progress".
      localDataVersion.current += 1;
    }
    if (!created) return id;
    setText("");
    if (onLocalCommit) onLocalCommit();
    else setDraft("");
    // The IndexedDB transaction above is the local-first commit boundary. Once it
    // succeeds, a network or refresh failure must not reopen Quick Capture and let
    // a retry duplicate the task/project pair. syncToServer keeps pendingKey set
    // on failure, so focus/online recovery can safely retry the same snapshot.
    try {
      await syncToServer();
      await load();
      if (selected && inspectorSelectionRef.current?.id === selected.id) {
        const refreshed = await db.entities.get(selected.id);
        if (refreshed && inspectorSelectionRef.current?.id === selected.id) await inspect(refreshed, { navigate: false });
      }
    } catch {
      setSyncStatus("offline");
      await load().catch(() => undefined);
    }
    return id;
  }

  function openCapture(type: "task" | "note" = "task", projectId = "") {
    // R3-FE-4a: no target create endpoint exists yet; legacy capture must not write legacy data in target mode.
    if (blockLegacyWrite()) return;
    captureOpener.current = document.activeElement as HTMLElement | null;
    const projectWorkspaceId = (projectId && items.find((item) => item.id === projectId && item.type === "project")?.workspaceId) || "";
    const workspaceId = initialCaptureWorkspace(projectWorkspaceId, personalWorkspaceId);
    replaceCaptureScope(type, workspaceId, projectId);
    setCaptureWriteWorkspaceId(workspaceId);
    setCaptureSharedConsentKey("");
    setCaptureType(type);
    setCaptureProjectId(projectId);
    setCaptureAreaId("");
    captureAreaTouched.current = false;
    setCaptureSuggestion(null);
    setCaptureSuggestionError("");
    setCaptureSuggestionBusy(false);
    setUseCaptureSuggestion(true);
    setCaptureProjectAction(projectId ? "existing" : "none");
    setCapture(true);
  }
  async function submitCapture() {
    const title = draft.trim();
    if (!title) return;
    const submittedDraft = draft;
    const submittedKey = captureDraftKey.current;
    const submittedRevision = captureDraftRevisions.current.get(submittedKey) ?? 0;
    // Commit boundary is local IndexedDB, not network sync. Late completions
    // must not clear a new capture (even if it reuses the same scope key).
    const clearCommittedDraft = () => {
      if ((captureDraftRevisions.current.get(submittedKey) ?? 0) !== submittedRevision) return;
      captureDrafts.current.delete(submittedKey);
      if (captureDraftKey.current === submittedKey) {
        setDraft((current) => current === submittedDraft ? "" : current);
      }
    };
    const parsed = parseCapture(title);
    const suggestion = captureType === "task" && useCaptureSuggestion ? captureSuggestion : null;
    if (suggestion?.newProjectSuggestion && (
      !captureProjectAction ||
      (captureProjectAction === "new" && !suggestion.newProjectSuggestion.title.trim()) ||
      (captureProjectAction === "existing" && !suggestion.projectId)
    )) {
      setCaptureSuggestionError(tr("chooseProjectBeforeAdding"));
      return;
    }
    const suggestedProjectId = captureProjectId || (captureProjectAction === "existing" ? suggestion?.projectId : "") || "";
    const suggestedNewProjectTitle = captureProjectAction === "new"
      ? suggestion?.newProjectSuggestion?.title.trim() || ""
      : "";
    // Only an area from the workspace the task goes to (a project's own workspace, otherwise the
    // chosen one) is kept; another one would be a cross-workspace link and the task could not be added.
    const destinationWorkspaceId = (suggestedProjectId && items.find((item) => item.id === suggestedProjectId && item.type === "project")?.workspaceId) || captureWriteWorkspaceId;
    const destinationConsentKey = captureDestinationKey({
      type: captureType, workspaceId: destinationWorkspaceId,
      projectId: suggestedProjectId, areaId: captureType === "task" ? captureAreaId : "",
      projectAction: captureProjectAction, newProjectTitle: suggestedNewProjectTitle,
    });
    if (captureNeedsShareConsent(destinationWorkspaceId, personalWorkspaceId) &&
        captureSharedConsentKey !== destinationConsentKey) {
      setCaptureSuggestionError(tr("captureShareApprovalRequired"));
      return;
    }
    const suggestedAreaId = items.some((item) => item.id === captureAreaId && item.type === "area" && item.workspaceId === destinationWorkspaceId)
      ? captureAreaId
      : "";
    const suggestedDate = parsed.when || suggestion?.scheduledDate || "";
    const globalTask = captureType === "task" && !captureProjectId;
    setCapture(false);
    if (!captureProjectId && activeWorkspaceId !== "all" && activeWorkspaceId !== destinationWorkspaceId) {
      setActiveWorkspaceId(destinationWorkspaceId);
      localStorage.setItem("ai-executive-active-workspace", destinationWorkspaceId);
    }
    selectWriteWorkspace(destinationWorkspaceId);
    if (globalTask) {
      closeDetail();
      setMoreOpen(false);
      setView(suggestedDate === today ? "Today" : "Inbox");
    }
    try {
      await create(captureType, title, {
        workspaceId: destinationWorkspaceId,
        ...(suggestedProjectId ? { projectId: suggestedProjectId } : {}),
        ...(suggestedNewProjectTitle ? { newProjectTitle: suggestedNewProjectTitle } : {}),
        ...(suggestedAreaId ? { areaId: suggestedAreaId } : {}),
        ...(captureType === "task"
          ? {
              originalCaptureText: title.slice(0, 1000),
              inbox: !suggestedProjectId && !suggestedNewProjectTitle && !suggestedDate,
              today: suggestedDate === today,
              ...(suggestedDate ? { when: suggestedDate } : {}),
              ...(suggestion && parsed.priority === "none" ? { priority: suggestion.priority } : {}),
              ...(suggestion ? {
                estimatedMinutes: suggestion.estimatedMinutes,
                plannedStart: suggestion.scheduledStart,
                plannedEnd: suggestion.scheduledEnd,
                planningSource: "albert-suggestion",
              } : {}),
            }
          : {}),
      }, clearCommittedDraft);
    } catch (error) {
      console.error(error);
      // A failed earlier submission may not reopen the sheet or replace the
      // text and suggestion state of another draft the user is now editing.
      if (captureDraftKey.current !== submittedKey ||
          (captureDraftRevisions.current.get(submittedKey) ?? 0) !== submittedRevision) {
        setSyncStatus("offline");
        return;
      }
      if (error instanceof Error && error.message === "PROJECT_ALREADY_EXISTS" && captureSuggestion?.newProjectSuggestion) {
        const workspaceId = captureWriteWorkspaceId;
        const duplicate = findActiveProjectWithTitle(items, workspaceId, captureSuggestion.newProjectSuggestion.title);
        setCaptureSuggestion(duplicate ? {
          ...captureSuggestion,
          projectId: duplicate.id,
          projectTitle: duplicate.title,
        } : captureSuggestion);
        setCaptureProjectAction("");
        setCaptureSuggestionError(tr("projectAlreadyExists"));
      } else {
        setSyncStatus("offline");
      }
      setDraft(title);
      setCapture(true);
    }
  }
  // A value replaced by a change from another device (lib/field-merge.ts): put it back, or keep
  // the current value. Either way the notice is removed on every device.
  async function resolveConflict(e: Entity, conflictId: string, restore: boolean) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    const current = (await db.entities.get(e.id)) || e;
    const conflict = entityConflicts(current).find((item) => item.id === conflictId);
    if (!conflict) return;
    // A shortened value is only for reading; it cannot be put back.
    if (restore && conflict.truncated) return;
    if (restore && conflict.field.startsWith("relation.")) {
      // The project or area it belonged to. If that one no longer exists (or is elsewhere), the
      // notice stays, so the replaced value is not silently forgotten.
      try {
        await relate(e.id, typeof conflict.lostValue === "string" ? conflict.lostValue : "", conflict.field.slice("relation.".length));
      } catch {
        return;
      }
    }
    localDataVersion.current += 1;
    try {
      await db.transaction("rw", db.entities, async () => {
        const latest = (await db.entities.get(e.id)) || current;
        const properties: Record<string, unknown> = {
          ...latest.properties,
          [conflictsKey]: entityConflicts(latest).filter((item) => item.id !== conflictId),
        };
        const update: Partial<Entity> = { updatedAt: writeTime() };
        if (restore && !conflict.field.startsWith("relation.")) {
          if (conflict.field === "properties.checklist") {
            // Only the items whose other version was replaced go back; items added since stay.
            const lostItems = Array.isArray(conflict.lostValue) ? conflict.lostValue as Array<{ id?: string }> : [];
            const currentItems = Array.isArray(properties.checklist) ? properties.checklist as Array<{ id?: string }> : [];
            const byId = new Map(lostItems.filter((item) => item && typeof item.id === "string").map((item) => [item.id, item]));
            properties.checklist = [
              ...currentItems.map((item) => (item && typeof item.id === "string" && byId.has(item.id) ? byId.get(item.id) : item)),
              ...lostItems.filter((item) => item && typeof item.id === "string" && !currentItems.some((current) => current?.id === item.id)),
            ];
          } else if (conflict.field === "properties.placement") {
            const lost = conflict.lostValue && typeof conflict.lostValue === "object" ? conflict.lostValue as Record<string, unknown> : {};
            for (const key of placementFields) {
              if (lost[key] === undefined) delete properties[key];
              else properties[key] = lost[key];
            }
          } else if (conflict.field.startsWith("properties.")) {
            const key = conflict.field.slice("properties.".length);
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || key === conflictsKey) return;
            if (conflict.lostValue === null || conflict.lostValue === undefined) delete properties[key];
            else properties[key] = conflict.lostValue;
            // A restored project context keeps `goal` mirroring its "Hotovo, když" for the previous app version.
            if (key === "context" && conflict.lostValue && typeof (conflict.lostValue as { doneWhen?: unknown }).doneWhen === "string") {
              properties.goal = (conflict.lostValue as { doneWhen: string }).doneWhen;
            }
          } else if (conflict.field === "content") {
            update.content = typeof conflict.lostValue === "string" ? conflict.lostValue : "";
          } else if ((conflict.field === "title" || conflict.field === "status") && typeof conflict.lostValue === "string" && conflict.lostValue) {
            (update as Record<string, unknown>)[conflict.field] = conflict.lostValue;
            // The completion time follows the restored state.
            if (conflict.field === "status" && conflict.lostValue === "completed") properties.completedAt = properties.completedAt || Date.now();
            else if (conflict.field === "status") delete properties.completedAt;
          }
        }
        const activity = Array.isArray(properties.activity) ? properties.activity : [];
        properties.activity = [...activity, { at: Date.now(), action: restore ? "change restored" : "change kept" }].slice(-50);
        update.properties = properties;
        await db.entities.update(e.id, update);
      });
    } finally {
      localDataVersion.current += 1;
    }
    await syncToServer();
    await load();
    const saved = (await db.entities.get(e.id)) || null;
    setSelected((open) => (open && open.id === e.id ? saved : open));
  }
  // The open record follows the local copy: a merge with another device's changes (or any other
  // write) must show up in the detail, or a later blur would write the replaced values back. A
  // title being typed is kept.
  useEffect(() => {
    if (!selected) return;
    const fresh = items.find((item) => item.id === selected.id);
    if (!fresh || fresh.type !== selected.type ||
        (activeWorkspaceId !== "all" && fresh.workspaceId !== activeWorkspaceId)) {
      closeDetail(); // Deleted, wrong type or no longer in the selected legacy scope.
      return;
    }
    // Compared by content: a merged record can keep the timestamp it had.
    const shown = { ...fresh, title: titleEdited.current ? selected.title : fresh.title };
    if (JSON.stringify(shown) === JSON.stringify(selected)) return;
    setSelected((open) => (open && open.id === fresh.id ? { ...fresh, title: titleEdited.current ? open.title : fresh.title } : open));
  }, [items, activeWorkspaceId, selected?.id, selected?.type]);
  // The add row is shared by every list; its message belongs to the list it was shown under.
  useEffect(() => setRowError(false), [view]);
  // The add row under a list: a refused item keeps its text and says so instead of failing silently.
  async function createFromRow(type: EntityType, title: string) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    setRowError(false);
    try {
      await create(type, title, type === "task" ? { originalCaptureText: title.trim().slice(0, 1000) } : {});
    } catch (error) {
      // Kept in the console as well; the message alone would hide the cause.
      console.error(error);
      setRowError(true);
    }
  }
  async function relate(
    sourceId: string,
    targetId: string,
    relationType: string,
    clearInbox = false,
  ) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    const source = await db.entities.get(sourceId);
    const target = targetId ? await db.entities.get(targetId) : null;
    if (!source || source.type === "workspace") return;
    if (targetId && !target) throw new Error("The selected relation target no longer exists");
    if (target && target.workspaceId !== source.workspaceId) {
      throw new Error("Cross-workspace relations are not allowed");
    }
    if (clearInbox && (source.type !== "task" || relationType !== "belongs_to_project" ||
        target?.type !== "project" || activeWorkspaceId === "all" ||
        activeWorkspaceId !== source.workspaceId || writeWorkspaceId !== source.workspaceId)) {
      throw new Error("Inbox triage needs an explicit writable workspace and a project in it");
    }
    localDataVersion.current += 1;
    const relationTimestamp = writeTime();
    try {
      await db.transaction("rw", db.entities, db.relations, async () => {
        // Dexie serializes read-write transactions over relations across tabs.
        // Reading the old membership outside this transaction would let both tabs
        // observe an empty list and then each insert a belongs_to_project relation.
        const latest = await db.entities.get(sourceId);
        const currentTarget = targetId ? await db.entities.get(targetId) : null;
        if (!latest || latest.type === "workspace" || latest.workspaceId !== source.workspaceId) {
          throw new Error("Relation source changed");
        }
        if (targetId && (!currentTarget || currentTarget.workspaceId !== latest.workspaceId)) {
          throw new Error("Relation target changed");
        }
        if (clearInbox && (latest.type !== "task" || relationType !== "belongs_to_project" ||
            currentTarget?.type !== "project" || currentTarget.status !== "active" ||
            latest.status !== "open" || latest.properties.inbox !== true ||
            activeWorkspaceId !== latest.workspaceId || writeWorkspaceId !== latest.workspaceId)) {
          throw new Error("Inbox triage target or workspace changed");
        }
        // 2a part 4: a task in a project inherits the Area of its project and has none of its own.
        if (relationType === "belongs_to_area" && targetId && latest.type === "task" && await taskIsInProject(latest)) {
          throw new Error("A task in a project inherits the Area of its project");
        }
        const existing = await db.relations
          .where("sourceEntityId")
          .equals(sourceId)
          .filter((relation) => relation.relationType === relationType)
          .toArray();
        await db.relations.bulkDelete(existing.map((relation) => relation.id));
        const joinsProject = relationType === "belongs_to_project" && latest.type === "task" && Boolean(targetId);
        if (joinsProject) await dropTaskAreaLinks(sourceId);
        if (targetId) {
          await db.relations.add({
            id: crypto.randomUUID(),
            workspaceId: latest.workspaceId,
            sourceEntityId: sourceId,
            targetEntityId: targetId,
            relationType,
            createdAt: relationTimestamp,
          });
        }
        const updatedProperties: Record<string, unknown> = {
          ...latest.properties,
          ...(clearInbox ? { inbox: false } : {}),
          relationsUpdatedAt: relationTimestamp,
          ...(clearInbox ? {
            activity: [
              ...(Array.isArray(latest.properties.activity) ? latest.properties.activity : []),
              { at: relationTimestamp, action: "triaged to project" },
            ].slice(-50),
          } : {}),
        };
        if (joinsProject) delete updatedProperties.areaId;
        await db.entities.update(sourceId, { properties: updatedProperties, updatedAt: relationTimestamp });
        // Leaving a project, or clearing the Area of a project / standalone task, never leaves it without an Area: the
        // workspace's fallback Area is the default.
        if (!targetId && (relationType === "belongs_to_project" || relationType === "belongs_to_area")) {
          const updated = await db.entities.get(sourceId);
          if (updated && !(relationType === "belongs_to_area" && updated.type === "task" && await taskIsInProject(updated))) {
            await assignFallbackArea(updated, relationTimestamp);
          }
        }
      });
    } finally {
      // An aborted transaction must not leave the app in a write-in-progress state.
      localDataVersion.current += 1;
    }
    await syncToServer();
    await load();
    // Finishing a relation write must not reopen an inspector that has since switched
    // to another record or been closed. inspect() also guards delayed context results.
    if (selected && inspectorSelectionRef.current?.id === selected.id) {
      const refreshed = await db.entities.get(selected.id);
      if (refreshed && inspectorSelectionRef.current?.id === selected.id) await inspect(refreshed, { navigate: false });
    }
  }
  // Inbox decisions are single-use. Every branch, including Discard, validates the latest
  // task in the same IndexedDB write transaction as the mutation. This serializes
  // competing kinds of triage (Today vs Waiting, project vs Discard) across tabs.
  async function triageInbox(
    task: Entity,
    destination: "today" | "someday" | "waiting" | "plan" | "project" | "organize" | "discard",
    value: string | { projectId?: string; areaId?: string } = "",
  ) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    if (activeWorkspaceRef.current === "all" || activeWorkspaceRef.current !== task.workspaceId ||
        writeWorkspaceId !== task.workspaceId) {
      throw new Error("Inbox triage requires an explicit writable workspace");
    }
    const timestamp = writeTime();
    const discarded: { record: Entity | null; relations: Relation[] } = { record: null, relations: [] };
    localDataVersion.current += 1;
    try {
      await db.transaction("rw", db.entities, db.relations, async () => {
        const latest = await db.entities.get(task.id);
        if (!latest || latest.type !== "task" || latest.status !== "open" ||
            latest.properties.inbox !== true || latest.workspaceId !== task.workspaceId ||
            activeWorkspaceRef.current !== latest.workspaceId || writeWorkspaceId !== latest.workspaceId) {
          throw new Error("Inbox task has already been triaged or is not writable");
        }
        if (destination === "discard") {
          const linked = await db.relations.filter((relation) =>
            relation.sourceEntityId === task.id || relation.targetEntityId === task.id).toArray();
          await db.entities.delete(task.id);
          await db.relations.bulkDelete(linked.map((relation) => relation.id));
          discarded.record = latest;
          discarded.relations = linked;
          return;
        }
        let joinsProject = false;
        if (destination === "project" || destination === "organize") {
          // B4 combines project and area into one single-use decision: both
          // memberships and Inbox exit commit in the *same* transaction.
          // An empty selection preserves the unrelated relation type.
          const chosen: { projectId?: string; areaId?: string } = destination === "project"
            ? { projectId: typeof value === "string" ? value : "" }
            : typeof value === "object" ? value : {};
          const assignments = [
            { id: chosen.projectId || "", type: "project", relation: "belongs_to_project" },
            { id: chosen.areaId || "", type: "area", relation: "belongs_to_area" },
          ].filter((assignment) => assignment.id);
          if (!assignments.length) throw new Error("Inbox triage needs a project or an area");
          // 2a part 4: a task in a project has no Area of its own; the UI offers either a project or an Area.
          if (chosen.projectId && chosen.areaId) {
            throw new Error("Inbox triage takes a project or an area, not both: the task inherits its project's Area");
          }
          if (chosen.areaId && await taskIsInProject(latest)) {
            throw new Error("A task in a project inherits the Area of its project");
          }
          joinsProject = Boolean(chosen.projectId);
          // Validate all targets before deleting *any* pre-existing relations.
          const targets = await Promise.all(assignments.map(async ({ id, type, relation }) => {
            const target = await db.entities.get(id);
            if (!target || target.type !== type || target.status !== "active" ||
                target.workspaceId !== latest.workspaceId) {
              throw new Error("Inbox triage target is unavailable in this workspace");
            }
            return { id, relation };
          }));
          for (const target of targets) {
            const previous = await db.relations.where("sourceEntityId").equals(task.id)
              .filter((relation) => relation.relationType === target.relation).toArray();
            await db.relations.bulkDelete(previous.map((relation) => relation.id));
            await db.relations.add({
              id: crypto.randomUUID(), workspaceId: latest.workspaceId,
              sourceEntityId: task.id, targetEntityId: target.id,
              relationType: target.relation, createdAt: timestamp,
            });
          }
          // The task now inherits the Area of its project (a standalone Inbox task had the fallback Area).
          if (joinsProject) await dropTaskAreaLinks(task.id);
        }
        if (destination === "plan" && (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value))) {
          throw new Error("Invalid Inbox scheduling date");
        }
        const when = destination === "today" ? ymd()
          : destination === "plan" && typeof value === "string" ? value : "";
        const actionProperties: Record<string, unknown> =
          destination === "today" || destination === "someday" || destination === "plan"
            ? {
                when,
                today: destination === "today" || (destination === "plan" && when === ymd()),
                someday: destination === "someday",
              }
            : destination === "waiting"
              ? { waiting: true, waitingSince: Date.now(), waitingFor: "", followUpDate: "" }
              : destination === "project" || destination === "organize" ? { relationsUpdatedAt: timestamp } : {};
        const activity = Array.isArray(latest.properties.activity) ? latest.properties.activity : [];
        const triagedProperties: Record<string, unknown> = {
          ...latest.properties,
          ...actionProperties,
          inbox: false,
          activity: [...activity, { at: timestamp, action: "inbox triaged: " + destination }].slice(-50),
        };
        if (joinsProject) delete triagedProperties.areaId;
        await db.entities.update(task.id, { properties: triagedProperties, updatedAt: timestamp });
      });
    } finally {
      localDataVersion.current += 1;
    }
    if (discarded.record) {
      recordDeleted(localStorage, task.id);
      setUndo(discarded.record);
      setUndoRelations(discarded.relations);
    }
    await syncToServer();
    await load();
    // An old decision must neither reopen an inspector nor close a different one.
    if (inspectorSelectionRef.current?.id === task.id) {
      if (discarded.record) closeDetail();
      else {
        const refreshed = await db.entities.get(task.id);
        if (refreshed && inspectorSelectionRef.current?.id === task.id) await inspect(refreshed, { navigate: false });
      }
    }
  }
  // A batch is committed by one authoritative server transaction. A normal
  // local-first snapshot merge could silently drop one remotely deleted member
  // and still apply the rest of the batch, violating the review guarantee.
  async function triageInboxBatch(
    selection: readonly { id: string; workspaceId: string; updatedAt: number }[],
    destination: "today" | "tomorrow" | "someday" | "waiting" | "organize",
    assignment: { projectId?: string; areaId?: string; projectRevision?: number; areaRevision?: number;
                  projectTitle?: string; areaTitle?: string } = {},
  ) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    const workspaceId = activeWorkspaceRef.current;
    if (signedOut.current || isAdopting() || authStateRef.current !== "ready" ||
        workspaceId === "all" || workspaceId !== writeWorkspaceId ||
        view !== "Inbox" || selection.length < 1 || selection.length > 50 ||
        new Set(selection.map(task => task.id)).size !== selection.length ||
        selection.some(task => task.workspaceId !== workspaceId)) {
      throw new Error("Inbox batch requires online access and an explicit writable workspace");
    }
    // Do not bypass pending local edits with an independent server write.
    // They have their own sync protocol and must settle before the CAS call.
    await syncQueue.current;
    if (localStorage.getItem(pendingKey) === "1" || syncStatus !== "synced") {
      throw new Error("Sync pending; retry Inbox batch once the device is synced");
    }
    const targets = destination === "organize" ? [
      ...(assignment.projectId ? [{ id: assignment.projectId, type: "project" as const,
        updatedAt: assignment.projectRevision, title: assignment.projectTitle }] : []),
      ...(assignment.areaId ? [{ id: assignment.areaId, type: "area" as const,
        updatedAt: assignment.areaRevision, title: assignment.areaTitle }] : []),
    ] : [];
    if (destination === "organize" && targets.length === 0) throw new Error("Select a project or area");
    if (targets.length > 1) throw new Error("Select a project or an area, not both: a task in a project inherits its Area");
    // Also protect against changes in a second tab of *this browser* before
    // reaching the server. Canonical CAS alone would not notice these while
    // their local snapshot is still waiting to sync.
    await db.transaction("r", db.entities, async () => {
      const latest = await db.entities.bulkGet(selection.map(item => item.id));
      if (activeWorkspaceRef.current !== workspaceId || latest.some((task, index) =>
          !task || task.type !== "task" || task.status !== "open" ||
          task.workspaceId !== workspaceId || task.properties.inbox !== true ||
          task.updatedAt !== selection[index].updatedAt ||
          !isSendable(task) || entityConflicts(task).length > 0)) {
        throw new Error("Inbox batch changed locally; review again");
      }
      for (const target of targets) {
        const entity = await db.entities.get(target.id);
        if (!entity || entity.workspaceId !== workspaceId || entity.type !== target.type ||
            entity.status !== "active" || entity.updatedAt !== target.updatedAt ||
            entity.title !== target.title || !isSendable(entity)) {
          throw new Error("Inbox batch destination changed locally; review again");
        }
      }
    });
    if (localStorage.getItem(pendingKey) === "1") throw new Error("Local edits are pending sync");
    const response = await fetch("/api/inbox/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        restoreGeneration: restoreGeneration.current ?? 0,
        selection: selection.map(task => ({ id: task.id, updatedAt: task.updatedAt })),
        action: destination,
        ...(destination === "today" || destination === "tomorrow"
          ? { date: ymd(addLocalDays(new Date(), destination === "today" ? 0 : 1)) } : {}),
        targets,
      }),
    });
    if (!response.ok) {
      // Refresh after a canonical 409 so the user can see the changed task or
      // destination before selecting a fresh batch. No local batch was written.
      if (response.status === 409) await pullFromServer().catch(() => undefined);
      throw new Error("Inbox batch was not applied on the server; review again");
    }
    // Another tab may be viewing the same IndexedDB. Pull the authoritative
    // revision before notifying it, and never call snapshot PUT for this batch.
    await pullFromServer();
    postToTabs({ type: "changed", from: tabId.current });
    setBatchSelection({ workspaceId: "", ids: [] });
  }

  // `seq`: the count of key presses in the title when the save started (see titleEditSeq). If more
  // was typed meanwhile, the open detail keeps what is being typed.
  async function rename(e: Entity, title: string, seq?: number) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    // The fallback Area is the system Area: it keeps its name.
    if (isFallbackArea(e, items)) return;
    // Restored data is being adopted and the page reloads: nothing typed against the replaced data is saved (lib/adoption.ts).
    if (isAdopting()) return;
    if (!title.trim()) return;
    const current = (await db.entities.get(e.id)) || e;
    // Leaving the field without a change writes nothing (and cannot put back a replaced title).
    if (current.title === title.trim()) return;
    const activity = Array.isArray(current.properties.activity)
      ? current.properties.activity
      : [];
    localDataVersion.current += 1;
    await db.entities.update(e.id, {
      title: title.trim(),
      properties: {
        ...current.properties,
        activity: [...activity, { at: Date.now(), action: "renamed" }].slice(-50),
      },
      updatedAt: writeTime(),
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    const saved = (await db.entities.get(e.id)) || null;
    setSelected((open) => {
      // The desktop list stays interactive: a save for A must not reopen A or replace B after the
      // user has moved on while the asynchronous save was in flight.
      if (!saved || !open || open.id !== saved.id) return open;
      const typedSince = seq !== undefined && titleEditSeq.current !== seq;
      return typedSince ? { ...saved, title: open.title } : saved;
    });
  }
  // Build the confirmation baseline after the title/context blur writes settle.
  async function projectPreviewActionSnapshot(projectId: string): Promise<ProjectPreviewActionSnapshot> {
    await waitForProjectWrites(projectId);
    return db.transaction("r", db.entities, db.relations, async () => {
      const current = await db.entities.get(projectId);
      if (!current) throw new Error("project_preview_changed");
      assertPreviewProjectMutation(current, current);
      const dependents = await projectPreviewDependencies(current);
      return { project: current, dependents: dependents.signature, openTasks: dependents.openTaskCount };
    });
  }
  async function projectPreviewDependencies(project: Entity) {
    const entities = await db.entities.where("workspaceId").equals(project.workspaceId).toArray();
    const relations = await db.relations.toArray();
    return projectPreviewDependents(project, entities, relations);
  }
  // Recheck both the current in-scope snapshot and the IndexedDB row within the write lock.
  function assertPreviewProjectMutation(expected: Entity, current: Entity | undefined): asserts current is Entity {
    const guards = previewWriteGuardsRef.current;
    const blocked = isAdopting() || signedOut.current || openProjectIdRef.current !== expected.id ||
      guards.unsent.has(expected.id) ||
      guards.heldBack.some((entity) => entity.id === expected.id) ||
      (current ? entityConflicts(current).length > 0 : true);
    const visible = latestItemsRef.current.find((entity) => entity.id === expected.id);
    if (!current || !visible || visible.type !== "project" || visible.workspaceId !== expected.workspaceId ||
        !projectPreviewCanCommit(expected, current, activeWorkspaceRef.current, blocked)) {
      throw new Error("project_preview_changed");
    }
  }
  async function remove(e: Entity, expectedPreview?: ProjectPreviewActionSnapshot) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    if (isFallbackArea(e, items)) return;
    let linkedRelations = expectedPreview ? [] as Relation[] : (await db.relations.toArray()).filter(
      (relation) => relation.sourceEntityId === e.id || relation.targetEntityId === e.id,
    );
    localDataVersion.current += 1;
    try {
      await db.transaction("rw", db.entities, db.relations, async () => {
        if (expectedPreview) {
          const current = await db.entities.get(e.id);
          assertPreviewProjectMutation(expectedPreview.project, current);
          if ((await projectPreviewDependencies(current)).signature !== expectedPreview.dependents)
            throw new Error("project_preview_changed");
          linkedRelations = (await db.relations.toArray()).filter(
            (relation) => relation.sourceEntityId === e.id || relation.targetEntityId === e.id,
          );
        }
        await db.entities.delete(e.id);
        await db.relations.bulkDelete(linkedRelations.map((relation) => relation.id));
        // Deleting a project: its member tasks become standalone tasks, which have exactly one Area (the fallback), and
        // no longer point at the project (2a part 4; the server does the same for a write that removes a project).
        if (e.type === "project") {
          const memberIds = new Set(linkedRelations.filter((relation) => relation.relationType === "belongs_to_project" && relation.targetEntityId === e.id).map((relation) => relation.sourceEntityId));
          const members = [...(await db.entities.where("workspaceId").equals(e.workspaceId).filter((task) => task.type === "task").toArray())]
            .filter((task) => memberIds.has(task.id) || task.properties.projectId === e.id);
          const stamp = writeTime();
          for (const task of members) {
            const properties = { ...task.properties };
            delete properties.projectId;
            const updated: Entity = { ...task, properties: { ...properties, relationsUpdatedAt: stamp }, updatedAt: Math.max(stamp, task.updatedAt + 1) };
            await db.entities.put(updated);
            await assignFallbackArea(updated, stamp);
          }
        }
      });
    } finally { localDataVersion.current += 1; }
    recordDeleted(localStorage, e.id);
    setUndo(e);
    setUndoRelations(linkedRelations);
    // Local deletion is already committed. A network failure is not a rollback;
    // finish navigation/Undo first, then report it in the persistent app-level alert.
    let syncFailed = false;
    try { await syncToServer({ reportFailure: Boolean(expectedPreview) }); }
    catch { syncFailed = true; }
    if (inspectorSelectionRef.current?.id === e.id) closeDetail();
    if (openProjectIdRef.current === e.id) closeProjectPage();
    if (expectedPreview) await load(); else void load();
    if (syncFailed) {
      setProjectSyncNotices((current) => withProjectSyncNotice(current,
        { kind: "delete", projectId: e.id, projectTitle: e.title, workspaceId: e.workspaceId,
          workspaceTitle: items.find((item) => item.type === "workspace" && item.workspaceId === e.workspaceId)?.title }));
      throw new Error("project_preview_sync_pending");
    }
    if (expectedPreview) setProjectSyncNotices((current) => withoutProjectSyncNotice(current, e.id));
  }
  async function setProjectStatus(project: Entity, status: "active" | "completed", expectedPreview?: ProjectPreviewActionSnapshot) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    if (project.type !== "project") return;
    let committedAt = 0;
    if (expectedPreview) {
      localDataVersion.current += 1;
      try {
        await db.transaction("rw", db.entities, db.relations, async () => {
          const current = await db.entities.get(project.id);
          assertPreviewProjectMutation(expectedPreview.project, current);
          if ((await projectPreviewDependencies(current)).signature !== expectedPreview.dependents)
            throw new Error("project_preview_changed");
          const timestamp = writeTime();
          committedAt = timestamp;
          const activity = Array.isArray(current.properties.activity) ? current.properties.activity : [];
          await db.entities.update(project.id, {
            status,
            properties: {
              ...current.properties,
              completedAt: status === "completed" ? timestamp : null,
              activity: [...activity, { at: timestamp, action: status === "completed" ? "completed" : "reopened" }].slice(-50),
            },
            updatedAt: timestamp,
          });
        });
      } finally { localDataVersion.current += 1; }
    } else {
      // Default-off legacy mutation keeps its original behavior.
      const current = (await db.entities.get(project.id)) || project;
      const timestamp = writeTime();
      const activity = Array.isArray(current.properties.activity) ? current.properties.activity : [];
      localDataVersion.current += 1;
      await db.entities.update(project.id, {
        status,
        properties: {
          ...current.properties,
          completedAt: status === "completed" ? timestamp : null,
          activity: [...activity, { at: timestamp, action: status === "completed" ? "completed" : "reopened" }].slice(-50),
        },
        updatedAt: timestamp,
      });
      localDataVersion.current += 1;
    }
    // The local status has already changed. Keep it visible even if the server
    // write failed, then report the unconfirmed sync to the preview UI.
    let syncFailed = false;
    try { await syncToServer({ reportFailure: Boolean(expectedPreview) }); }
    catch { syncFailed = true; }
    await load();
    const saved = (await db.entities.get(project.id)) || null;
    setSelected((open) => open?.id === project.id ? saved : open);
    if (syncFailed) {
      setProjectSyncNotices((current) => withProjectSyncNotice(current,
        { kind: "status", projectId: project.id, projectTitle: project.title,
          workspaceId: project.workspaceId,
          workspaceTitle: items.find((item) => item.type === "workspace" && item.workspaceId === project.workspaceId)?.title,
          status, updatedAt: committedAt }));
      throw new Error("project_preview_sync_pending");
    }
    if (expectedPreview) setProjectSyncNotices((current) => withoutProjectSyncNotice(current, project.id));
  }
  async function restore() {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    if (!undo) return;
    if (undoDecisions.current?.entity === undo) {
      const { previous } = undoDecisions.current;
      undoDecisions.current = null;
      localDataVersion.current += 1;
      await db.transaction("rw", db.entities, async () => {
        const current = await db.entities.get(undo.id);
        if (current) await db.entities.put({ ...current, properties: restoreCalendarDecisions(current, previous, Date.now()), updatedAt: writeTime() });
      });
      localDataVersion.current += 1;
      setUndo(null);
      setUndoRelations([]);
      await syncToServer();
      load();
      return;
    }
    if (undoCreated.current === undo) {
      const created = undo;
      undoCreated.current = null;
      const linkedRelations = (await db.relations.toArray()).filter((relation) => relation.sourceEntityId === created.id || relation.targetEntityId === created.id);
      localDataVersion.current += 1;
      await db.transaction("rw", db.entities, db.relations, async () => {
        await db.entities.delete(created.id);
        await db.relations.bulkDelete(linkedRelations.map((relation) => relation.id));
      });
      localDataVersion.current += 1;
      recordDeleted(localStorage, created.id);
      setUndo(null);
      setUndoRelations([]);
      await syncToServer();
      if (inspectorSelectionRef.current?.id === created.id) closeDetail();
      load();
      return;
    }
    localDataVersion.current += 1;
    await db.transaction("rw", db.entities, db.relations, async () => {
      await db.entities.put({
        ...undo,
        status: undo.type === "task" && undo.status === "completed" ? "open" : undo.status,
        updatedAt: writeTime(),
      });
      if (undoRelations.length) await db.relations.bulkPut(undoRelations);
    });
    localDataVersion.current += 1;
    recordRevived(localStorage, undo.id);
    // The old pending-delete banner is already false once Undo has recreated the record.
    setProjectSyncNotices((current) => projectSyncNoticesAfterUndo(current, undo.id));
    await syncToServer();
    setUndo(null);
    setUndoRelations([]);
    load();
  }
  // `onlyIfOpen`: put the saved record into the detail panel only while that record is still the
  // one open there (a save that finishes after the panel was closed must not reopen it).
  // `properties` may be a function of the stored properties, for a change that depends on them
  // (a checklist item ticked): it is then computed from the stored record, not from what is shown.
  async function patch(e: Entity, properties: Record<string, unknown> | ((stored: Record<string, unknown>) => Record<string, unknown>), action = "updated", onlyIfOpen = false, expectedTaskSnapshot?: string) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    // Restored data is being adopted and the page reloads: nothing typed against the replaced data is saved (lib/adoption.ts).
    if (isAdopting()) return;
    localDataVersion.current += 1;
    // Reading and writing in one transaction: two saves of the same record started together (for
    // example leaving the notes field by ticking a checklist item) must not overwrite each other.
    // The write marker is released even if the write fails (sign-out waits for it).
    try { await db.transaction("rw", db.entities, async () => {
      const loaded = await db.entities.get(e.id);
      // Confirm against the live record inside the read/write transaction.
      // This closes the race between tapping Approve and an intervening edit.
      if (expectedTaskSnapshot &&
        (!loaded || todayProposalTaskSignature(loaded) !== expectedTaskSnapshot))
        throw new Error("Reviewed task changed");
      const current = loaded || e;
      const activity = Array.isArray(current.properties.activity)
        ? current.properties.activity
        : [];
      await db.entities.update(e.id, {
        properties: {
          ...current.properties,
          ...(typeof properties === "function" ? properties(current.properties) : properties),
          activity: [...activity, { at: Date.now(), action }].slice(-50),
        },
        updatedAt: writeTime(),
      });
    }); } finally {
      localDataVersion.current += 1;
    }
    await syncToServer();
    await load();
    const saved = (await db.entities.get(e.id)) || null;
    // The title may be being typed in the same panel (it is saved when its field is left), so the
    // panel keeps its own title.
    // A title that differs from the one the save started with is being typed and is kept; otherwise
    // the saved title is shown (it may have been changed on another device).
    // The inspector is non-modal on desktop. Preserve a different selection (and a closed panel)
    // when an older save completes; only the record still open may be refreshed.
    setSelected((open) => (open && saved && open.id === e.id
      ? { ...saved, title: open.title !== e.title ? open.title : saved.title }
      : open));
  }
  // Notes are typed into a draft and saved when the field is left. Saving on every key press put
  // the stored value back into the field while the save was running, so typed characters were
  // lost. Every key press also keeps the draft in the device (lib/notes-drafts.ts), because that
  // write is synchronous and survives the page being closed or killed before the save could run.
  // The draft is dropped only if nothing was typed into it since this save started. If the save
  // fails the draft stays, so the text is still in the field and is saved next time.
  const pageId = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  function editNotes(id: string, text: string, base: string) {
    setNotesDraft({ id, text });
    keepNotesDraft(localStorage, pageId.current, id, text, base);
  }
  async function saveNotes(e: Pick<Entity, "id">, notes: string) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    // Restored data is being adopted and the page reloads: nothing typed against the replaced data is saved (lib/adoption.ts).
    if (isAdopting()) return;
    try {
      const stored = await db.entities.get(e.id);
      if (stored && String(stored.properties.notes || "") !== notes) await patch(stored, { notes }, "updated", true);
    } catch {
      return;
    }
    setNotesDraft((draft) => (draft && draft.id === e.id && draft.text === notes ? null : draft));
    settleNotesDraft(localStorage, pageId.current, e.id, notes);
  }
  // The body of a note is typed like task notes: a draft kept in the device on every key press (under
  // a key of its own, so it is never mistaken for task notes), saved through the normal save path when
  // the field is left. A failed local write keeps the draft and says so.
  const noteBodyKey = (id: string) => `note-body:${id}`;
  // Drafts of other notes this page still holds, kept in memory too in case the device storage failed.
  const parkedNoteBodies = useRef(new Map<string, { id: string; text: string; base: string }>());
  function editNoteBody(id: string, text: string, base: string) {
    const open = noteBodyDraftRef.current;
    if (open && open.id !== id) parkedNoteBodies.current.set(open.id, open);
    setNoteBodyDraft((current) => ({ id, text, base: current && current.id === id ? current.base : base }));
    setNoteBodyError((failed) => (failed === id ? null : failed));
    keepNotesDraft(localStorage, pageId.current, noteBodyKey(id), text, base);
  }
  // Writes the title and/or text of a note in one local write, then sends it to the server.
  async function patchNoteText(e: Entity, fields: { title?: string; content?: string }, action: string, keepTypedTitle: boolean) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    // Restored data is being adopted and the page reloads: nothing typed against the replaced data is saved (lib/adoption.ts).
    if (isAdopting()) return;
    localDataVersion.current += 1;
    try { await db.transaction("rw", db.entities, async () => {
      const current = (await db.entities.get(e.id)) || e;
      const activity = Array.isArray(current.properties.activity) ? current.properties.activity : [];
      await db.entities.update(e.id, {
        ...fields,
        properties: { ...current.properties, activity: [...activity, { at: Date.now(), action }].slice(-50) },
        updatedAt: writeTime(),
      });
    }); } finally {
      localDataVersion.current += 1;
    }
    await syncToServer();
    await load();
    const saved = (await db.entities.get(e.id)) || null;
    setSelected((open) => (open && saved && open.id === e.id
      ? { ...saved, title: keepTypedTitle && open.title !== e.title ? open.title : saved.title }
      : open));
  }
  async function saveNoteBody(e: Pick<Entity, "id">, text: string) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    // Restored data is being adopted and the page reloads: nothing typed against the replaced data is saved (lib/adoption.ts).
    if (isAdopting()) return;
    try {
      const stored = await db.entities.get(e.id);
      // The note was deleted (for example on another device): the text is kept and the save reported as failed.
      if (!stored || stored.type !== "note") { setNoteBodyError(e.id); return; }
      {
        const now = stored.content ?? "";
        const kept = keptNotesDrafts(localStorage).find((draft) => draft.page === pageId.current && draft.id === noteBodyKey(e.id));
        const open = noteBodyDraftRef.current;
        const base = kept?.base ?? (open && open.id === e.id ? open.base : undefined);
        // The text was started from text that is no longer the note's: newer text from another device
        // is never overwritten; the draft stays and the owner chooses.
        if (now !== text && base !== undefined && base !== now) {
          setNoteBodyConflict(e.id);
          return;
        }
        if (now !== text) {
          await patchNoteText(stored, { content: text }, "updated", true);
          // Newer text from another device may have won the merge while this was being sent: the draft stays.
          if (((await db.entities.get(e.id))?.content ?? "") !== text) { setNoteBodyConflict(e.id); return; }
        }
      }
    } catch {
      setNoteBodyError(e.id);
      return;
    }
    setNoteBodyError((failed) => (failed === e.id ? null : failed));
    setNoteBodyConflict((conflict) => (conflict === e.id ? null : conflict));
    // Typing that went on during the save now starts from what was saved.
    setNoteBodyDraft((draft) => (draft && draft.id === e.id ? (draft.text === text ? null : { ...draft, base: text }) : draft));
    settleParkedNoteBody(e.id, text);
    settleNotesDraft(localStorage, pageId.current, noteBodyKey(e.id), text);
  }
  // The owner's choice in a conflict: "mine" saves the draft over the newer text (which stays in the version
  // history), "theirs" drops the draft and shows the stored text.
  async function resolveNoteBodyConflict(id: string, choice: "mine" | "theirs") {
    if (choice === "theirs") {
      setNoteBodyDraft((draft) => (draft && draft.id === id ? null : draft));
      setNoteBodyConflict((conflict) => (conflict === id ? null : conflict));
      setNoteBodyError((failed) => (failed === id ? null : failed));
      try { removeNoteBodyDraft(id); } catch { /* storage unavailable */ }
      return;
    }
    const draft = noteBodyDraftRef.current;
    if (!draft || draft.id !== id) return;
    try {
      const stored = await db.entities.get(id);
      // The note was deleted meanwhile: the text is kept and the save reported as failed.
      if (!stored || stored.type !== "note") { setNoteBodyError(id); return; }
      if ((stored.content ?? "") !== draft.text) {
        await patchNoteText(stored, { content: draft.text }, "updated", true);
        if (((await db.entities.get(id))?.content ?? "") !== draft.text) return; // still in conflict: the draft stays
      }
    } catch {
      setNoteBodyError(id);
      return;
    }
    setNoteBodyError((failed) => (failed === id ? null : failed));
    setNoteBodyConflict((conflict) => (conflict === id ? null : conflict));
    setNoteBodyDraft((open) => (open && open.id === id ? (open.text === draft.text ? null : { ...open, base: draft.text }) : open));
    settleParkedNoteBody(id, draft.text);
    settleNotesDraft(localStorage, pageId.current, noteBodyKey(id), draft.text);
  }
  // Restoring an old version is an ordinary new edit: its title and text become the note's.
  // "changed": after syncing, the note does not hold the restored text (newer text from another device won the merge).
  async function restoreNoteVersion(e: Entity, title: string, content: string): Promise<"restored" | "changed" | "failed"> {
    try {
      const stored = await db.entities.get(e.id);
      if (!stored || stored.type !== "note") return "failed";
      if (stored.title !== title || (stored.content ?? "") !== content) await patchNoteText(stored, { title, content }, "restored version", false);
      const after = await db.entities.get(e.id);
      if (!after || after.title !== title || (after.content ?? "") !== content) return "changed";
    } catch {
      setNoteBodyError(e.id);
      return "failed";
    }
    // Restoring is offered only while the note has no draft, so there is none to clear here. A draft typed
    // meanwhile (in this note or in another one opened during the save) is the owner's newer text and stays.
    setNoteBodyError((failed) => (failed === e.id ? null : failed));
    return "restored";
  }
  // A save of a note that was parked meanwhile (another note opened) settles its parked copy too.
  function settleParkedNoteBody(id: string, saved: string) {
    const parked = parkedNoteBodies.current.get(id);
    if (!parked) return;
    if (parked.text === saved) parkedNoteBodies.current.delete(id);
    else parkedNoteBodies.current.set(id, { ...parked, base: saved });
  }
  function removeNoteBodyDraft(id: string) {
    const kept = keptNotesDrafts(localStorage).find((draft) => draft.page === pageId.current && draft.id === noteBodyKey(id));
    if (kept) dropNotesDraft(localStorage, kept);
  }
  const noteBodyDraftRef = useRef(noteBodyDraft);
  noteBodyDraftRef.current = noteBodyDraft;
  // The page keeps one note's draft in memory; a draft of another note this page kept (for example an
  // unresolved conflict left by opening a different note) is taken up again when that note is opened.
  const openNoteId = selected?.type === "note" ? selected.id : null;
  useEffect(() => {
    if (!openNoteId) return;
    const open = noteBodyDraftRef.current;
    if (open && open.id === openNoteId) return;
    let kept: { text: string; base: string } | undefined;
    try { kept = keptNotesDrafts(localStorage).find((draft) => draft.page === pageId.current && draft.id === noteBodyKey(openNoteId)); } catch { /* storage unavailable */ }
    kept ??= parkedNoteBodies.current.get(openNoteId);
    parkedNoteBodies.current.delete(openNoteId);
    if (!kept) return;
    const found = kept;
    setNoteBodyDraft({ id: openNoteId, text: found.text, base: found.base });
    void db.entities.get(openNoteId).then((stored) => {
      const now = stored?.content ?? "";
      if (stored && now !== found.text && now !== found.base) setNoteBodyConflict(openNoteId);
    });
  }, [openNoteId]);
  const saveNoteBodyRef = useRef(saveNoteBody);
  saveNoteBodyRef.current = saveNoteBody;
  // A phone may close the app in the background without the field ever being left, so a draft is
  // saved as soon as the page is hidden.
  const notesDraftRef = useRef(notesDraft);
  notesDraftRef.current = notesDraft;
  const saveNotesRef = useRef(saveNotes);
  saveNotesRef.current = saveNotes;
  useEffect(() => {
    const saveDraft = (event: Event) => {
      if (event.type === "visibilitychange" && document.visibilityState !== "hidden") return;
      const draft = notesDraftRef.current;
      if (draft) void saveNotesRef.current({ id: draft.id }, draft.text);
      const body = noteBodyDraftRef.current;
      if (body) void saveNoteBodyRef.current({ id: body.id }, body.text);
    };
    document.addEventListener("visibilitychange", saveDraft);
    window.addEventListener("pagehide", saveDraft);
    return () => {
      document.removeEventListener("visibilitychange", saveDraft);
      window.removeEventListener("pagehide", saveDraft);
    };
  }, []);
  // Another tab is signing out: what is being typed here is saved first (an edited title and the
  // notes draft), and editing stops until that tab has finished or given up (lib/tab-coordination.ts).
  const forSignOut = useRef({ selected, rename, saveNotes, capture, draft, checklistDraft, contextInboxText, text });
  forSignOut.current = { selected, rename, saveNotes, capture, draft, checklistDraft, contextInboxText, text };
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(tabChannelName);
    let unblock = 0;
    const block = () => {
      document.body.inert = true;
      setSigningOutElsewhere(true);
      // If the other tab is closed before it finishes, editing comes back here on its own. While
      // it is still signing out (for example asking the user), it says so every few seconds.
      window.clearTimeout(unblock);
      unblock = window.setTimeout(release, 15_000);
    };
    const release = () => {
      window.clearTimeout(unblock);
      if (signedOut.current) return;
      document.body.inert = false;
      setSigningOutElsewhere(false);
    };
    channel.onmessage = async (event: MessageEvent<TabMessage>) => {
      const message = event.data;
      if (!message || message.from === tabId.current) return;
      if (message.type === "sign-out-cancelled") { release(); return; }
      // A tab opened (or woken) after the request still stops editing and saves what it can.
      if (message.type === "signing-out") {
        const wasBlocked = document.body.inert;
        block();
        if (!wasBlocked) void saveForSignOut().catch(() => undefined);
        return;
      }
      if (message.type !== "save-for-sign-out") return;
      channel.postMessage({ type: "saving", from: tabId.current, request: message.request } satisfies TabMessage);
      block();
      const unsaved = await saveForSignOut();
      channel.postMessage({ type: "saved", from: tabId.current, request: message.request, unsaved } satisfies TabMessage);
    };
    // Saves an edited title and the notes draft; returns the number of texts that could not be
    // saved (texts that are not records, and a title whose save failed).
    async function saveForSignOut() {
      const { selected: open, rename: saveTitle, saveNotes: saveDraft, capture: captureOpen, draft: captureText, checklistDraft: checklistText, contextInboxText: inboxText, text: rowText } = forSignOut.current;
      // Texts that are not records cannot be saved; the signing-out tab asks the user about them.
      let unsaved = [captureOpen && captureText.trim(), rowText.trim(), checklistText.trim(), inboxText.trim()].filter(Boolean).length;
      if (open && titleEdited.current) {
        try {
          await saveTitle(open, open.title);
          // Only a title that was really written counts as saved.
          titleEdited.current = false;
        } catch {
          unsaved += 1;
        }
      }
      // A notes draft that cannot be saved stays kept in the device and is counted as unsent.
      const notes = notesDraftRef.current;
      if (notes) await saveDraft({ id: notes.id }, notes.text).catch(() => undefined);
      const body = noteBodyDraftRef.current;
      if (body) await saveNoteBodyRef.current({ id: body.id }, body.text).catch(() => undefined);
      noteOpenTexts();
      return unsaved;
    }
    return () => { window.clearTimeout(unblock); channel.close(); };
  }, []);
  // What is being typed here and not saved anywhere yet is noted in the device as it is typed
  // (lib/open-texts.ts), so a tab signing out asks about it even if this tab is asleep.
  function noteOpenTexts() {
    const { selected: open, capture: captureOpen, draft: captureText, checklistDraft: checklistText, contextInboxText: inboxText, text: rowText } = forSignOut.current;
    const kinds: OpenTextKind[] = [];
    if (open && titleEdited.current) kinds.push("title");
    // The capture dialog, or the add row under a list.
    if ((captureOpen && captureText.trim()) || rowText.trim()) kinds.push("capture");
    if (checklistText.trim()) kinds.push("checklist");
    if (inboxText.trim()) kinds.push("contextInbox");
    try { setOpenTexts(localStorage, pageId.current, kinds); } catch { /* storage unavailable */ }
  }
  useEffect(noteOpenTexts, [selected?.title, capture, draft, checklistDraft, contextInboxText, text]);
  // The edited-title mark belongs to the record that was open: another record (or none) starts
  // clean, so its title follows changes merged in and is not overwritten by a later blur. A save
  // still on its way finishes on its own.
  useEffect(() => {
    titleEdited.current = false;
    titleEditSeq.current += 1;
    noteOpenTexts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);
  useEffect(() => {
    const leave = () => { try { setOpenTexts(localStorage, pageId.current, []); } catch { /* storage unavailable */ } };
    // Shown again (also restored from the back/forward cache): the note is written again and
    // renewed, and notes of tabs long gone are removed.
    const back = () => {
      if (document.visibilityState !== "visible") return;
      noteOpenTexts();
      try { renewOpenTexts(localStorage, pageId.current); } catch { /* storage unavailable */ }
    };
    back();
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);
  // Drafts left by other pages. A page that is still open answers on the draft channel, and its
  // drafts are left to it.
  const draftChannelName = "ai-executive-notes-draft";
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(draftChannelName);
    channel.onmessage = (event) => {
      // An open page always answers: every draft it kept (being typed, parked behind another note, or
      // waiting in a conflict) is still its own, and only a page that is really gone leaves drafts behind.
      if (event.data?.ask === pageId.current) channel.postMessage({ alive: pageId.current });
    };
    return () => channel.close();
  }, []);
  // Without the channel, a draft typed into in the last 30 seconds is taken as still open.
  function draftOwnerOpen(draft: KeptNotesDraft) {
    return new Promise<boolean>((resolve) => {
      if (typeof BroadcastChannel === "undefined") { resolve(Date.now() - draft.at < 30_000); return; }
      const channel = new BroadcastChannel(draftChannelName);
      const done = (open: boolean) => { channel.close(); resolve(open); };
      const wait = window.setTimeout(() => done(false), 400);
      channel.onmessage = (event) => {
        if (event.data?.alive === draft.page) { window.clearTimeout(wait); done(true); }
      };
      channel.postMessage({ ask: draft.page });
    });
  }
  // Saves the drafts that pages left behind into the local copy. On start (`signingOut` false) the
  // drafts of pages that are still open are left to them, and a draft whose notes were changed
  // since it was started (for example on another device) is dropped: the newer notes stay. When
  // signing out every draft is saved, because the other pages are about to lose theirs; one that
  // conflicts with newer notes stays kept, so sign-out asks before discarding it.
  // Returns true if a draft was left to a page that is still open.
  async function saveLeftoverDrafts(signingOut: boolean, stopped = () => false) {
    let leftToOwner = false;
    const owners = new Map<string, boolean>();
    for (const draft of keptNotesDrafts(localStorage)) {
      if (stopped()) return leftToOwner;
      if (!signingOut) {
        if (draft.page === pageId.current) continue;
        if (!owners.has(draft.page)) owners.set(draft.page, await draftOwnerOpen(draft));
        if (owners.get(draft.page)) { leftToOwner = true; continue; }
      }
      const isBody = draft.id.startsWith("note-body:");
      const stored = await db.entities.get(isBody ? draft.id.slice("note-body:".length) : draft.id);
      if (stopped()) return leftToOwner;
      const action = leftoverDraftAction(draft, isBody
        ? (stored && stored.type === "note" ? stored.content ?? "" : undefined)
        : stored ? String(stored.properties.notes || "") : undefined);
      if (action === "conflict" && signingOut) continue;
      // A note text whose note is gone (deleted on another device) is never thrown away: it stays in the device.
      if (action === "gone" && isBody) continue;
      if (action === "conflict" && isBody) {
        // Never deleted silently: the text is adopted into this page's draft and the note shows the conflict.
        const id = draft.id.slice("note-body:".length);
        // A draft this page is typing (of any note) is never replaced; the left draft waits in the device.
        if (noteBodyDraftRef.current || parkedNoteBodies.current.has(id)) continue;
        keepNotesDraft(localStorage, pageId.current, draft.id, draft.text, draft.base);
        dropNotesDraft(localStorage, draft);
        setNoteBodyDraft({ id, text: draft.text, base: draft.base });
        setNoteBodyConflict(id);
        continue;
      }
      if (action === "save" && stored) {
        try {
          if (isBody) await patchNoteText(stored, { content: draft.text }, "updated", true);
          else await patch(stored, { notes: draft.text }, "updated", true);
        } catch {
          continue;
        }
        // Newer text from another device may have won the merge meanwhile: the left text is kept, never settled away.
        if (isBody && ((await db.entities.get(stored.id))?.content ?? "") !== draft.text) continue;
      }
      // If that page typed on in the meantime, its draft now starts from what was saved.
      if (action === "gone") dropNotesDraft(localStorage, draft);
      else settleNotesDraft(localStorage, draft.page, draft.id, draft.text);
    }
    return leftToOwner;
  }
  // Leftover drafts are saved once the start-up synchronization has succeeded: only then are the
  // newest notes known, so a draft cannot win over notes changed on another device. Drafts left to
  // a page that is still open are looked at again later.
  useEffect(() => {
    if (authState !== "ready" || syncStatus !== "synced") return;
    let timer: number | undefined;
    let stopped = false;
    const recover = async () => {
      if (stopped) return;
      if (await saveLeftoverDrafts(false, () => stopped) && !stopped) timer = window.setTimeout(() => void recover(), 30_000);
    };
    void recover();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [authState, syncStatus]);
  function scheduleTask(task: Entity, destination: "today" | "tomorrow" | "someday" | "clear" | string) {
    const when = destination === "today" ? ymd()
      : destination === "tomorrow" ? ymd(addLocalDays(new Date(), 1))
        : destination === "someday" || destination === "clear" ? "" : destination;
    return patch(task, {
      when,
      today: destination === "today" || when === ymd(),
      someday: destination === "someday",
      inbox: false,
      evening: false,
    }, `scheduled ${destination}`);
  }
  // The "When" popover: one choice saves at once. Resolves to true when the task was changed; false
  // when nothing was (read-only aggregate, unknown date, or the owner declined a date after the deadline).
  // The deadline is never touched; the previous state is the single-step Undo.
  async function deferTask(
    task: Entity,
    choice: "today" | "evening" | "tomorrow" | "weekend" | "nextWeek" | "someday" | "clear" | string,
    via: "manual" | "lumi",
    expectedTaskSnapshot?: string,
  ): Promise<boolean> {
    if (blockLegacyWrite()) return false;
    if (activeWorkspaceId === "all" || isAdopting() || deferInFlight.current) return false;
    // One choice at a time: a second one while the first is being saved would replace its Undo snapshot.
    deferInFlight.current = true;
    setDeferBusy(true);
    setDeferError(false);
    try {
      const stored = (await db.entities.get(task.id)) || (expectedTaskSnapshot ? null : task);
      if (!stored || stored.type !== "task" || stored.status !== "open" ||
        (expectedTaskSnapshot && todayProposalTaskSignature(stored) !== expectedTaskSnapshot)) return false;
      const targets = deferTargets(ymd());
      const when = choice === "today" || choice === "evening" ? targets.today
        : choice === "tomorrow" ? targets.tomorrow
          : choice === "weekend" ? targets.weekend
            : choice === "nextWeek" ? targets.nextWeek
              : choice === "someday" || choice === "clear" ? ""
                : /^\d{4}-\d{2}-\d{2}$/.test(choice) ? choice : null;
      if (when === null) return false;
      const deadline = typeof stored.properties.deadline === "string" ? stored.properties.deadline.slice(0, 10) : "";
      // After a passed deadline today is the earliest day possible, so it needs no confirmation.
      if (/^\d{4}-\d{2}-\d{2}$/.test(deadline) && when && when > deadline && when > targets.today) {
        const confirmed = await askConfirm({
          title: tr("deferAfterDeadlineTitle"),
          message: tr("deferAfterDeadline").replace("{date}", () => inSentenceDate(deadline, language)),
          confirmLabel: tr("deferAfterDeadlineConfirm"),
        });
        if (!confirmed) return false;
        // The task may have been completed or deleted (here or on another device) while the question was open.
        const again = await db.entities.get(task.id);
        if (!again || again.type !== "task" || again.status !== "open") return false;
      }
      await patch(stored, (current) => {
        const previous = typeof current.when === "string" && current.when ? current.when : current.someday === true ? "someday" : null;
        const next = when || (choice === "someday" ? "someday" : null);
        const history = Array.isArray(current.deferHistory) ? current.deferHistory : [];
        return {
          when,
          today: when === ymd(),
          someday: choice === "someday",
          inbox: false,
          evening: choice === "evening",
          ...(previous !== next ? { deferHistory: [...history, { from: previous, to: next, at: Date.now(), via }].slice(-10) } : {}),
        };
      }, `deferred ${choice}`, false, expectedTaskSnapshot);
      // The previous state becomes the Undo step only once the change is written.
      setUndo(stored);
      setUndoRelations([]);
      return true;
    } catch {
      setDeferError(true);
      return false;
    } finally {
      deferInFlight.current = false;
      setDeferBusy(false);
    }
  }
  // The popover belongs to the list it was opened on.
  useEffect(() => { setDeferOpen(null); setDeferError(false); }, [view, activeWorkspaceId]);
  async function done(id: string) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    if (workSession?.taskId === id) { await workSessionAction("finish"); return; }
    const t = await db.entities.get(id);
    if (
      t?.type === "task" &&
      (t.properties.recurrence || t.properties.repeat)
    ) {
      const rec = (t.properties.recurrence || {
        frequency: t.properties.repeat,
        interval: 1,
        mode: "scheduled",
      }) as any;
      const base =
        rec.mode === "completion"
          ? new Date()
          : new Date(String(t.properties.when || today));
      const next = new Date(base),
        n = Number(rec.interval || 1);
      if (rec.frequency === "daily") next.setDate(next.getDate() + n);
      if (rec.frequency === "weekly") next.setDate(next.getDate() + 7 * n);
      if (rec.frequency === "monthly") {
        const desiredDay = next.getDate();
        next.setDate(1);
        next.setMonth(next.getMonth() + n);
        const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(desiredDay, lastDay));
      }
      if (rec.frequency === "yearly") {
        const desiredDay = next.getDate();
        const desiredMonth = next.getMonth();
        next.setDate(1);
        next.setFullYear(next.getFullYear() + n);
        next.setMonth(desiredMonth);
        const lastDay = new Date(next.getFullYear(), desiredMonth + 1, 0).getDate();
        next.setDate(Math.min(desiredDay, lastDay));
      }
      const reminderLocal = toLocalDateTime(t.properties.reminderAt);
      const nextReminder = reminderLocal
        ? fromLocalDateTime(`${ymd(next)}T${reminderLocal.slice(11, 16)}`)
        : "";
      await create("task", t.title, {
        ...t.properties,
        workspaceId: t.workspaceId,
        entityId: `${t.id}:occurrence:${ymd(next)}`,
        projectId: targets(t.id, "belongs_to_project")[0],
        areaId: targets(t.id, "belongs_to_area")[0],
        when: ymd(next),
        reminderAt: nextReminder,
        today: false,
        inbox: false,
        // Waiting belongs to the completed occurrence, not to the next one.
        waiting: false,
        waitingFor: "",
        waitingSince: null,
        followUpDate: "",
        // Neither the evening mark nor the deferral history belongs to the next occurrence.
        evening: false,
        deferHistory: [],
      });
    }
    if (t) { setUndo(t); setUndoRelations([]); }
    localDataVersion.current += 1;
    await db.entities.update(id, {
      status: "completed",
      properties: {
        ...t?.properties,
        completedAt: Date.now(),
        activity: [
          ...(Array.isArray(t?.properties.activity) ? t.properties.activity : []),
          { at: Date.now(), action: "completed" },
        ].slice(-50),
      },
      updatedAt: writeTime(),
    });
    localDataVersion.current += 1;
    await syncToServer();
    // Completing task A must not close task B that was opened while syncing A.
    if (inspectorSelectionRef.current?.id === id) closeDetail();
    load();
  }
  async function reopenTask(task: Entity) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    const activity = Array.isArray(task.properties.activity) ? task.properties.activity : [];
    localDataVersion.current += 1;
    await db.entities.update(task.id, {
      status: "open",
      properties: {
        ...task.properties,
        completedAt: null,
        activity: [...activity, { at: Date.now(), action: "reopened" }].slice(-50),
      },
      updatedAt: writeTime(),
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    const saved = (await db.entities.get(task.id)) || null;
    setSelected((open) => open?.id === task.id ? saved : open);
  }
  const type: EntityType =
    view === "Projects"
      ? "project"
      : view === "Areas"
        ? "area"
        : view === "Notes"
          ? "note"
          : "task";
  // Today lists "This evening" after the other tasks, in the same list; keyboard moves follow what is shown.
  const collection = ["Projects", "Areas", "Notes"].includes(view)
    ? scopedItems.filter((x) => x.type === type).sort(byManualOrder(`${type}:all`))
    : view === "Today"
      ? [...visible.filter((x) => !isEveningTask(x, today)), ...visible.filter((x) => isEveningTask(x, today))]
      : visible;
  // UI-04c: the visible Dnes/Zítra Area blocks, not the old Today/Upcoming
  // membership lists, define keyboard and drag reorder peers in My Plan.
  // The legacy list behavior must be identical outside this opt-in route.
  const planReorderSections = mobileDesignV1Preview && mobilePlanPreviewActive &&
    view === "Today" && activeWorkspaceId !== "all"
    ? buildMyPlanPreview({ entities: items, relations: scopedRelations,
      workspaceId: activeWorkspaceId, today, excludeTimelineIds: todayTimelineTaskIds,
      priorityFilter, sortBy })
    : null;
  const batchAllowed = view === "Inbox" && authState === "ready" && syncStatus === "synced" &&
    activeWorkspaceId !== "all" && writeWorkspaceId === activeWorkspaceId;
  const batchCandidates = batchAllowed ? collection.filter((task) =>
    task.type === "task" && task.status === "open" && task.workspaceId === activeWorkspaceId &&
    task.properties.inbox === true && !heldReasons.has(task.id) &&
    entityConflicts(task).length === 0) : [];
  const batchCandidateIds = new Set(batchCandidates.map((task) => task.id));
  const batchIds = batchAllowed && batchSelection.workspaceId === activeWorkspaceId
    ? batchSelection.ids.filter((id) => batchCandidateIds.has(id)) : [];
  // Prevent a remembered selection from reappearing after a workspace switch,
  // navigation away from Inbox, or sign-out.
  useEffect(() => {
    setBatchSelection({ workspaceId: "", ids: [] });
  }, [activeWorkspaceId, view, authState, inboxTab]);
  function setBatchIds(ids: string[]) {
    setBatchSelection({
      workspaceId: activeWorkspaceId,
      ids: [...new Set(ids)].filter((id) => batchCandidateIds.has(id)).slice(0, 50),
    });
  }
  const draggedEntity = items.find((entity) => entity.id === draggingId);
  const draggableSectionNames = ["Inbox", "Today", "Anytime", "Someday", "Completed"];

  function setActiveDragTarget(target: string) {
    dragTargetRef.current = target;
    setDragTarget(target);
  }

  function targetAtPoint(clientX: number, clientY: number) {
    const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(
      "[data-drop-entity], [data-drop-section]",
    );
    if (!element) return "";
    return element.dataset.dropEntity
      ? `entity:${element.dataset.dropEntity}`
      : element.dataset.dropSection
        ? `section:${element.dataset.dropSection}`
        : "";
  }

  function beginPointerDrag(event: ReactPointerEvent<HTMLButtonElement>, id: string, scope: string) {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    dragScopeRef.current = scope;
    setActiveDragTarget("");
  }

  function movePointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const pending = pointerDragRef.current;
    if (!pending.id) return;
    event.preventDefault();
    if (!pending.active) {
      const distance = Math.hypot(
        event.clientX - pending.startX,
        event.clientY - pending.startY,
      );
      if (distance < 8) return;
      pending.active = true;
      draggingIdRef.current = pending.id;
      setDraggingId(pending.id);
    }
    setActiveDragTarget(targetAtPoint(event.clientX, event.clientY));
  }

  async function persistManualOrder(ordered: Entity[], movedId: string, scope: string, allAreaPeers?: Entity[]) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    if (allAreaPeers) {
      // Reordering a filtered My Plan group can require renumbering hidden
      // neighbours. None of the records about to change may be held, pending,
      // conflicted or outside the explicit currently writable workspace.
      const updates = previewManualRankUpdates(ordered, allAreaPeers, movedId, scope);
      if (updates?.length === 0) return;
      const workspaceId = allAreaPeers[0]?.workspaceId ?? "";
      const writableScope = () =>
        authState === "ready" && syncStatus === "synced" &&
        activeWorkspaceRef.current === workspaceId && writeWorkspaceId === workspaceId &&
        workspaceId !== "all" && !isAdopting() && !offlineRecoveryIsHeld() &&
        !signedOut.current && !signingOutElsewhere;
      const eligible = (records: Entity[]) =>
        Boolean(updates && previewRankWritesAllowed(
          updates, records, workspaceId, new Set(heldReasons.keys()), unsent,
        ));
      // Validate both the old records and their full post-write snapshots
      // before any mutation. A formerly valid large task can become held
      // after manualOrders/activity increases its properties size.
      const timestamp = writeTime();
      if (!updates || !writableScope() || !eligible(allAreaPeers) ||
          !previewRankNextRecords(updates, allAreaPeers, scope, timestamp)) {
        setPlanReorderError(true);
        return;
      }
      let saved = false;
      localDataVersion.current += 1;
      try {
        await db.transaction("rw", db.entities, async () => {
          const latest = await db.entities.bulkGet(allAreaPeers.map((task) => task.id));
          // Repeat the write gate inside the transaction against actual stored
          // records. All checks precede the first update, so an ineligible
          // hidden/conflicted/pending peer aborts the entire move.
          if (!writableScope() || latest.some((task, index) => !task ||
            task.updatedAt !== allAreaPeers[index].updatedAt ||
            task.workspaceId !== allAreaPeers[index].workspaceId ||
            task.status !== allAreaPeers[index].status ||
            JSON.stringify(task.properties) !== JSON.stringify(allAreaPeers[index].properties))) return;
          const fresh = latest.filter((task): task is Entity => Boolean(task));
          if (!eligible(fresh)) return;
          // Build and validate ALL successor records before the first update:
          // a rejection must leave the whole Area untouched.
          const nextRecords = previewRankNextRecords(updates, fresh, scope, timestamp);
          if (!nextRecords) return;
          for (const next of nextRecords) {
            await db.entities.update(next.id, {
              properties: next.properties,
              updatedAt: next.updatedAt,
            });
          }
          saved = true;
        });
      } catch {
        setPlanReorderError(true);
        return;
      } finally {
        localDataVersion.current += 1;
      }
      if (!saved) {
        setPlanReorderError(true);
        return;
      }
      setPlanReorderError(false);
      await syncToServer();
      await load();
      return;
    }
    const timestamp = writeTime();
    const movedIndex = ordered.findIndex((entity) => entity.id === movedId);
    const moved = ordered[movedIndex];
    if (!moved) return;
    const previous = movedIndex > 0 ? manualOrder(ordered[movedIndex - 1], scope) : null;
    const next = movedIndex < ordered.length - 1 ? manualOrder(ordered[movedIndex + 1], scope) : null;
    const rank = previous === null
      ? (next === null ? 1000 : next - 1000)
      : next === null
        ? previous + 1000
        : previous + (next - previous) / 2;
    const storedOrders = moved.properties.manualOrders;
    const manualOrders = storedOrders && typeof storedOrders === "object" && !Array.isArray(storedOrders)
      ? { ...(storedOrders as Record<string, unknown>) }
      : {};
    manualOrders[`${moved.workspaceId}:${scope}`] = rank;
    const activity = Array.isArray(moved.properties.activity)
      ? moved.properties.activity
      : [];
    localDataVersion.current += 1;
    await db.entities.update(moved.id, {
      properties: {
        ...moved.properties,
        manualOrders,
        activity: [...activity, { at: timestamp, action: "reordered" }].slice(-50),
      },
      updatedAt: timestamp,
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
  }

  async function moveTaskToSection(task: Entity, section: string) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    if (task.type !== "task" || !draggableSectionNames.includes(section)) return;
    if (section === "Completed") {
      await done(task.id);
      return;
    }
    const timestamp = writeTime();
    const properties = { ...task.properties };
    delete properties.when;
    properties.inbox = section === "Inbox";
    properties.today = section === "Today";
    properties.someday = section === "Someday";
    properties.evening = false;
    if (section === "Today") properties.when = today;
    const peers = tasks.filter((candidate) => {
      if (candidate.id === task.id || candidate.status !== "open" || candidate.workspaceId !== task.workspaceId) return false;
      return taskMatchesView(candidate, section === "Inbox" || section === "Today" || section === "Someday" ? section : "Anytime", today);
    });
    const scope = `task:${section}`;
    const storedOrders = task.properties.manualOrders;
    const manualOrders = storedOrders && typeof storedOrders === "object" && !Array.isArray(storedOrders)
      ? { ...(storedOrders as Record<string, unknown>) }
      : {};
    manualOrders[`${task.workspaceId}:${scope}`] = Math.max(0, ...peers.map((peer) => manualOrder(peer, scope))) + 1000;
    properties.manualOrders = manualOrders;
    const activity = Array.isArray(task.properties.activity) ? task.properties.activity : [];
    properties.activity = [...activity, { at: timestamp, action: `moved to ${section}` }].slice(-50);
    localDataVersion.current += 1;
    await db.entities.update(task.id, { properties, updatedAt: timestamp });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
  }

  // Projects are reordered inside their area group only (no write across groups).
  function projectGroupPeers(project: Entity) {
    const group = groupProjectsByArea(projects, areas, scopedRelations).find((candidate) => candidate.projects.some((row) => row.id === project.id));
    return group ? group.projects.filter((row) => row.workspaceId === project.workspaceId) : [];
  }

  function peersForScope(scope: string, workspaceId: string) {
    const [entityType, kind, ...rest] = scope.split(":");
    const id = rest.join(":");
    return scopedItems.filter((entity) => {
      if (entity.type !== entityType || entity.workspaceId !== workspaceId) return false;
      if (kind === "project") return entity.status !== "completed" && sources(id, "belongs_to_project").includes(entity.id);
      if (kind === "area") return (entity.type !== "task" || entity.status === "open") && sources(id, "belongs_to_area").includes(entity.id);
      if (entityType === "task") return taskMatchesView(entity, kind, today);
      return kind === "all";
    }).sort(byManualOrder(scope));
  }

  async function completeDrop(sourceId: string, target: string, scope = dragScopeRef.current) {
    // R3-FE-4a: unified target mode has no target create/edit API yet; legacy data is never written.
    if (blockLegacyWrite()) return undefined as never;
    const source = items.find((entity) => entity.id === sourceId);
    if (!source || !target) return;
    // My Plan's rows may only change manual rank inside their current visible
    // day + Area. Dragging onto a legacy section must not reschedule them.
    const planTaskDrag = planReorderSections !== null && source.type === "task";
    if (planTaskDrag && (sortBy !== "manual" || target.startsWith("section:"))) return;
    if (target.startsWith("section:")) {
      await moveTaskToSection(source, target.slice("section:".length));
      return;
    }
    if (!target.startsWith("entity:")) return;
    const targetEntity = items.find((entity) => entity.id === target.slice("entity:".length));
    if (!targetEntity || targetEntity.id === source.id || targetEntity.workspaceId !== source.workspaceId) return;
    if (source.type === targetEntity.type) {
      const planPeers = planTaskDrag
        ? previewReorderPeers(planReorderSections!, source.id, scope, targetEntity.id, sortBy)
        : null;
      if (planTaskDrag && !planPeers) return; // no fallback to legacy membership
      let peers = planTaskDrag ? planPeers! :
        source.type === "project" && scope === "project:all" ? projectGroupPeers(source) : peersForScope(scope, source.workspaceId);
      // Legacy Today keeps the separate evening group; My Plan groups by Area instead.
      if (!planTaskDrag && view === "Today" && scope === "task:Today" && source.type === "task") {
        const evening = isEveningTask(source, today);
        if (isEveningTask(targetEntity, today) !== evening) return;
        peers = peers.filter((candidate) => isEveningTask(candidate, today) === evening && !todayTimelineTaskIds.has(candidate.id));
      }
      const sourceIndex = peers.findIndex((entity) => entity.id === source.id);
      const targetIndex = peers.findIndex((entity) => entity.id === targetEntity.id);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const [moved] = peers.splice(sourceIndex, 1);
      const insertionIndex = peers.findIndex((entity) => entity.id === targetEntity.id);
      peers.splice(insertionIndex + (sourceIndex < targetIndex ? 1 : 0), 0, moved);
      if (planTaskDrag) {
        // The source/target are visible, but rank collision recovery must also
        // preserve filtered and timeline-linked rows of the same Area/day.
        const fullPlan = buildMyPlanPreview({
          entities: items, relations: scopedRelations,
          workspaceId: source.workspaceId, today, priorityFilter: "all",
          sortBy: "manual",
        });
        const allAreaPeers = previewReorderPeers(fullPlan, source.id, scope, undefined, "manual");
        if (!allAreaPeers) return;
        await persistManualOrder(peers, source.id, scope, allAreaPeers);
      } else {
        if (source.type === "task") setSortBy("manual");
        await persistManualOrder(peers, source.id, scope);
      }
      return;
    }
    if (planTaskDrag) return; // cross-type drops cannot mutate relations here
    if ((source.type === "task" || source.type === "note") && targetEntity.type === "project") {
      await relate(source.id, targetEntity.id, "belongs_to_project");
    } else if (source.type === "project" && targetEntity.type === "area") {
      await relate(source.id, targetEntity.id, "belongs_to_area");
    } else if (source.type === "task" && targetEntity.type === "area") {
      // A task in a project inherits its project's Area: dropping it on another Area is not a valid move.
      if (await taskIsInProject(source)) {
        // Visible feedback instead of a silent no-op.
        await askConfirm({ title: tr("area"), message: tr("dragProjectTaskToArea"), confirmLabel: tr("close") });
      } else {
        await relate(source.id, targetEntity.id, "belongs_to_area");
      }
    }
  }

  async function finishPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const pending = pointerDragRef.current;
    pointerDragRef.current = { id: "", startX: 0, startY: 0, active: false };
    if (!pending.active || !draggingIdRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceId = draggingIdRef.current;
    const target = dragTargetRef.current || targetAtPoint(event.clientX, event.clientY);
    draggingIdRef.current = "";
    setDraggingId("");
    setActiveDragTarget("");
    await completeDrop(sourceId, target, dragScopeRef.current);
  }

  function beginNativeDrag(event: ReactDragEvent<HTMLButtonElement>, id: string, scope: string) {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
    draggingIdRef.current = id;
    dragScopeRef.current = scope;
    setDraggingId(id);
  }

  async function acceptNativeDrop(event: ReactDragEvent<HTMLElement>, target: string) {
    event.preventDefault();
    event.stopPropagation();
    const sourceId = event.dataTransfer.getData("text/plain") || draggingIdRef.current;
    draggingIdRef.current = "";
    setDraggingId("");
    setActiveDragTarget("");
    await completeDrop(sourceId, target, dragScopeRef.current);
  }

  async function moveWithKeyboard(entity: Entity, direction: -1 | 1, scope: string) {
    const planKeyboard = planReorderSections !== null && entity.type === "task";
    const planPeers = planKeyboard ? previewReorderPeers(planReorderSections!, entity.id, scope, undefined, sortBy) : null;
    if (planKeyboard && !planPeers) return;
    let peers = planKeyboard ? planPeers! :
      view === "Home" && scope === "task:Today" ? homeTodayTasks
        : scope === `task:${view}` ? collection.filter((candidate) => candidate.workspaceId === entity.workspaceId)
          : entity.type === "project" && scope === "project:all" ? projectGroupPeers(entity)
            : peersForScope(scope, entity.workspaceId);
    // Today shows its evening tasks as a group of their own: a task moves within its own group only.
    if (!planKeyboard && view === "Today" && scope === "task:Today") {
      const evening = isEveningTask(entity, today);
      peers = peers.filter((candidate) => isEveningTask(candidate, today) === evening && !todayTimelineTaskIds.has(candidate.id));
    }
    const index = peers.findIndex((candidate) => candidate.id === entity.id);
    const target = peers[index + direction];
    if (index < 0 || !target) return;
    await completeDrop(entity.id, `entity:${target.id}`, scope);
  }

  // R3-FE-4b: in unified target mode the legacy drag handle is a natively disabled control (not
  // draggable, no pointer or keyboard reorder, calm hint) instead of an active one that only alerts.
  const dragHandle = (entity: Entity, scope: string) => captureDisabled ? (
    <button
      type="button"
      className="dragHandle"
      disabled
      draggable={false}
      aria-label={`${tr("moveItemNamed")} ${entity.title}`}
      title={detailCopy[language].legacyReadOnlyNotice}
      data-legacy-write-disabled="true"
    >
      <span aria-hidden="true">⠿</span>
    </button>
  ) : (
    <button
      className="dragHandle"
      draggable
      aria-label={`${tr("moveItemNamed")} ${entity.title}`}
      title={tr("dragToMove")}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        event.stopPropagation();
        void moveWithKeyboard(entity, event.key === "ArrowUp" ? -1 : 1, scope);
      }}
      onDragStart={(event) => beginNativeDrag(event, entity.id, scope)}
      onDragEnd={() => { draggingIdRef.current = ""; setDraggingId(""); setActiveDragTarget(""); }}
      onPointerDown={(event) => beginPointerDrag(event, entity.id, scope)}
      onPointerMove={movePointerDrag}
      onPointerUp={finishPointerDrag}
      onPointerCancel={() => {
        pointerDragRef.current = { id: "", startX: 0, startY: 0, active: false };
        draggingIdRef.current = "";
        setDraggingId("");
        setActiveDragTarget("");
      }}
    >
      <span aria-hidden="true">⠿</span>
    </button>
  );
  return {
    mailSourceToOpen,
    inboxTab,
    setInboxTab,
    projectsAttention,
    sidebarProjects,
    projectGroups,
    setMailSourceToOpen,
    ...attentionState,
    ...evidenceState,
    claimEffectivePredicate,
    claimRelationOptions,
    claimSubjectType,
    claimTargetType,
    providerLabel,
    relationLabel,
    setDayPlanNow,
    dayPlanNow,
    dayPlanStatus,
    setDayPlanStatus,
    dayPlanBusy,
    dayPlanUndo,
    workSession,
    workSessionBusy,
    workSessionStatus,
    dayPlanWhy,
    loadDayPlan,
    workSessionAction,
    visibleDayPlan,
    dayPlanTimeline,
    currentDayPlanBlock,
    nextDayPlanBlock,
    workElapsedText,
    workOverrun,
    applyDayPlanAction,
    undoDayPlanBlock,
    acceptNativeDrop,
    activeWorkspace,
    activeWorkspaceId,
    agentBusyId,
    agentResult,
    agentRuns,
    agentStatus,
    aiBusy,
    aiText,
    approveContextInbox,
    areas,
    projectPreviewActionSnapshot,
    trackProjectWrite,
    projectSyncNotices: Object.values(projectSyncNotices),
    dismissProjectSyncNotice: (projectId: string) =>
      setProjectSyncNotices((current) => withoutProjectSyncNotice(current, projectId)),
    askAI,
    assistantOpen,
    attentionTaskCount,
    answerConfirm,
    askConfirm,
    confirmRequest,
    authEnabled,
    authError,
    authNotice,
    authPassword,
    authState,
    offlineView,
    offlineRetry,
    retryAccess,
    backupStatus,
    backups,
    badgeStatus,
    calendarAction,
    calendarBusy,
    calendarFresh,
    calendarLabel,
    calendarSources,
    calendarStatus,
    calendarLoadSucceededVersion,
    getCalendarLoadGeneration: () => calendarLoadVersion.current,
    calendarTimezone,
    calendarToday,
    calendarUrl,
    calendarWorkspaceSelection,
    capture,
    captureModalRef,
    captureProjectAction,
    captureProjectId,
    captureAreaId,
    captureWriteWorkspaceId,
    captureSharedConsentKey,
    setCaptureSharedConsentKey,
    chooseCaptureArea,
    chooseCaptureType,
    editCaptureDraft,
    discardCaptureDraft,
    captureSuggestion,
    captureSuggestionBusy,
    captureSuggestionError,
    captureType,
    checkAccess,
    checklistDraft,
    claimBusyIds,
    claimFilterId,
    claimFreshness,
    claimHistory,
    claimPredicate,
    claimSensitivity,
    claimStatus,
    claimSubjectId,
    claimTargetId,
    claimValidFrom,
    claimValidTo,
    claimValue,
    claimValueMode,
    claimValueType,
    closeDetail,
    closeInspector,
    closeProjectPage,
    openProject,
    navigationUnavailable,
    dismissNavigationUnavailable: () => setNavigationUnavailable(false),
    collection,
    context,
    contextAction,
    contextBusy,
    contextClaimAction,
    contextClaims,
    contextHistory,
    contextHistoryAction,
    contextStepText,
    historyBusy,
    historyOffer,
    historySkip,
    historyStatus,
    contextContent,
    contextInboxBusy,
    contextInboxProposals,
    contextInboxReason,
    contextInboxStatus,
    contextInboxTasks,
    contextInboxText,
    contextPredicateLabel,
    contextProjectId,
    contextScope,
    contextSensitivity,
    contextStatus,
    contextSubjectTypeLabel,
    contextTitle,
    create,
    createFromRow,
    resolveConflict,
    titleEdited,
    titleEditSeq,
    noteOpenTexts,
    rowError,
    setRowError,
    createServerBackup,
    backupBusy,
    backupFailed,
    restoredNotice,
    dismissRestoredNotice,
    recoveryHeld,
    recoveryPreparing,
    recoveryReady,
    recoveryError,
    recoveryOffline,
    recoveryDownloadRequested,
    recoveryInspecting,
    recoveryInspection,
    recoveryInspectionError,
    inspectOfflineRecoveryFile,
    prepareOfflineRecoveryDownload,
    downloadOfflineRecovery,
    downloadExport,
    importExport,
    createSuggestedTarget,
    createWorkspace,
    disableNotifications,
    done,
    draft,
    dragHandle,
    dragTarget,
    draggableSectionNames,
    draggedEntity,
    draggingId,
    durableContext,
    editContextClaim,
    editingClaim,
    editNotes,
    enableNotifications,
    freeHours,
    freeWindows,
    // Raw calendar events feed the opt-in mobile day selector. It is the same
    // already-connected, legacy-scoped feed as Calendar's existing timeline.
    calendarEvents,
    calendarDayEventsAll,
    nearbyCalendarEventsAll,
    busyCalendarDayEvents,
    todayTimelineTaskIds,
    ...calendarEventsState,
    homeTodayTasks,
    homeToday,
    todayTasks,
    inspect,
    items,
    unsent,
    heldBack,
    heldReasons,
    language,
    loadCalendar,
    login,
    logout,
    logoutBusy,
    signingOutElsewhere,
    logoutError,
    messages,
    moreDialogRef,
    moreOpen,
    moreTriggerRef,
    markMobileMoreNavigation,
    nearbyCalendarEvents,
    newSubjectTitle,
    newSubjectType,
    newWorkspaceDraft,
    notesDraft,
    noteBodyDraft,
    noteBodyError,
    noteBodyConflict,
    resolveNoteBodyConflict,
    editNoteBody,
    saveNoteBody,
    restoreNoteVersion,
    notificationState,
    notificationStatus,
    openCapture,
    captureDisabled,
    legacyWritesDisabled: captureDisabled,
    legacyWriteAttempt,
    legacyReadOnlyHint: captureDisabled ? detailCopy[language].legacyReadOnlyNotice : undefined,
    dismissLegacyWriteAttempt: () => setLegacyWriteAttempt(false),
    pactAgents,
    parseCapture,
    passkeyBusy,
    passkeyLabel,
    passkeyPassword,
    passkeyStatus,
    passkeySupported,
    passkeys,
    patch,
    previewContextInbox,
    priorityFilter,
    projects,
    query,
    registerPasskey,
    relate,
    reloadContextClaims,
    remove,
    removePasskey,
    rename,
    reopenTask,
    resetClaimDraft,
    resolveAIProposal,
    resolvedTheme,
    restore,
    restoreAppBadge,
    restoreServerBackup,
    runPACTAgent,
    saveContextClaim,
    saveLanguage,
    saveNotes,
    saveNotificationSettings,
    saveTheme,
    saveWorkspaceName,
    scheduleTask,
    deferTask,
    deferOpen,
    setDeferOpen,
    deferBusy,
    deferError,
    setDeferError,
    scopedItems,
    scopedRelations,
    selectWorkspace,
    selectWriteWorkspace,
    selectCaptureWriteWorkspace,
    selected,
    setActiveDragTarget,
    setAiText,
    setAssistantOpen,
    setAuthPassword,
    setCalendarLabel,
    setCalendarStatus,
    setCalendarUrl,
    setCapture,
    setCaptureProjectAction,
    setCaptureSuggestion,
    setCaptureSuggestionError,
    setChecklistDraft,
    setClaimFilterId,
    setClaimFreshness,
    setClaimPredicate,
    setClaimSensitivity,
    setClaimSubjectId,
    setClaimTargetId,
    setClaimValidFrom,
    setClaimValidTo,
    setClaimValue,
    setClaimValueMode,
    setClaimValueType,
    setContextContent,
    setContextInboxProposals,
    setContextInboxStatus,
    setContextInboxTasks,
    setContextInboxText,
    setContextProjectId,
    setContextScope,
    setContextSensitivity,
    setContextTitle,
    setDraft,
    setMoreOpen,
    setNewSubjectTitle,
    setNewSubjectType,
    setNewWorkspaceDraft,
    setNotificationState,
    setPasskeyLabel,
    setPasskeyPassword,
    setPriorityFilter,
    setProjectStatus,
    setQuery,
    setSelected,
    setSettingsSaved,
    setSortBy,
    setStartupView,
    setSubjectEditId,
    setSubjectEditTitle,
    setSubjectSearch,
    setText,
    setUseCaptureSuggestion,
    setView,
    mobilePlanPreviewActive,
    setWorkspaceDraft,
    setWorkspaceMenuOpen,
    settingsSaved,
    settingsSection,
    setSettingsSection,
    showClaimHistory,
    showSubjectHistory,
    sidebarCounts,
    signInWithPasskey,
    sortBy,
    sources,
    standalone,
    standaloneSubjects,
    startupView,
    subjectAction,
    subjectBusy,
    subjectEditId,
    subjectEditTitle,
    subjectHistory,
    subjectSearch,
    subjectStatus,
    submitCapture,
    syncStatus,
    targets,
    taskDraftCaptureText,
    tasks,
    triageInbox,
    triageInboxBatch,
    batchAllowed,
    batchCandidates,
    batchIds,
    setBatchIds,
    planReorderError,
    setPlanReorderError,
    testAppBadge,
    testNotification,
    text,
    themeMode,
    today,
    calendarDayEvents,
    todayCalendarEvents,
    tr,
    type,
    undo,
    undoAIAction,
    useCaptureSuggestion,
    view,
    workspaceDraft,
    workspaceMenuOpen,
    workspaceName,
    // The colour of the active workspace, shared by the band, the tiles and the active navigation.
    activeWorkspaceTone: workspaceTone(activeWorkspaceId, activeWorkspace),
    workspaces,
    writeWorkspace,
    writeWorkspaceId,
  };
}

export type LumiApp = ReturnType<typeof useLumiApp>;
