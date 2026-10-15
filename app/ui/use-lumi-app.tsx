"use client";
import { type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { db, ensureDefaultWorkspace, migratePropertyRelations, personalWorkspaceId, readLocalWithBase, replaceSyncBase, seed, type Entity, type EntityType, type Relation } from "../../lib/db";
import { clearLocalData, finishInterruptedWipe, hasUnsentChanges, markSignedIn, signedInKey, signedOutKey } from "../../lib/local-data";
import { runSignOut } from "../../lib/sign-out";
import { clearPageNotesDrafts, dropNotesDraft, keepNotesDraft, keptNotesDrafts, leftoverDraftAction, settleNotesDraft, type KeptNotesDraft } from "../../lib/notes-drafts";
import { addressUpdate, viewFromSearch } from "../../lib/view-url";
import { buildContext, type ContextBundle } from "../../lib/context";
import { mergeSnapshots, type ServerSnapshot } from "../../lib/server-sync";
import { recordDeleted, recordRevived } from "../../lib/pending-markers";
import { writeTime } from "../../lib/clock";
import { otherOpenTexts, renewOpenTexts, setOpenTexts, type OpenTextKind } from "../../lib/open-texts";
import { forServer, isSendable } from "../../lib/sendable";
import { askOtherTabsToSave, postToTabs, tabChannelName, type TabMessage } from "../../lib/tab-coordination";
import { conflictsKey, entityConflicts, placementFields } from "../../lib/field-merge";
import { fetchClientAuthStatus } from "../../lib/client-auth-status";
import { addLocalDays, fromLocalDateTime, toLocalDateTime, ymd, zonedDateTimeToIso } from "../../lib/local-dates";
import { byManualOrder, manualOrder, newTaskPlacement, parseCaptureText, taskMatchesView } from "../../lib/task-views";
import { findActiveProjectWithTitle } from "../../lib/project-title";
import { type AIProposal, type AssistantMessage, type CalendarEvent, type CalendarSourceState, type CaptureProjectAction, type CaptureSuggestion, type ConfirmRequest, type ContextClaimItem, type ContextHistoryState, type ContextHistoryStep, type ContextInboxProposal, type ContextInboxTaskDraft, type DayPlanItem, type DurableContextItem, type Language, type NotificationState, type PACTAgentResult, type PACTAgentRunSummary, type PACTAgentSummary, type StandaloneSubjectItem, type ThemeMode } from "./types";
import { copy } from "./copy";
import { views } from "./navigation";
import { useAttention } from "./hooks/use-attention";
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

// All client state, effects and handlers of the Lumi app shell, moved verbatim from app/page.tsx.
// Views receive the returned object as `app` and destructure what they render.
export function useLumiApp() {
  const [view, setView] = useState("Home"),
    [text, setText] = useState(""),
    [rowError, setRowError] = useState(false),
    [selected, setSelected] = useState<Entity | null>(null),
    [notesDraft, setNotesDraft] = useState<{ id: string; text: string } | null>(null),
    [query, setQuery] = useState(""),
    [capture, setCapture] = useState(false),
    [captureType, setCaptureType] = useState<"task" | "note">("task"),
    [captureProjectId, setCaptureProjectId] = useState(""),
    [captureAreaId, setCaptureAreaId] = useState(""),
    [draft, setDraft] = useState(""),
    [captureSuggestion, setCaptureSuggestion] = useState<CaptureSuggestion | null>(null),
    [captureSuggestionBusy, setCaptureSuggestionBusy] = useState(false),
    [captureSuggestionError, setCaptureSuggestionError] = useState(""),
    [useCaptureSuggestion, setUseCaptureSuggestion] = useState(true),
    [captureProjectAction, setCaptureProjectAction] = useState<CaptureProjectAction>("none"),
    [undo, setUndo] = useState<Entity | null>(null),
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
  const { items, relations, unsent, heldBack, heldReasons, syncStatus, setSyncStatus, serverRevision, syncQueue, localDataVersion, signedOut, pendingKey,
    deletedKey, revivedKey, pendingDeletedIds, pendingRevivedIds, load, applySnapshot, putSnapshot, syncToServer,
    pullFromServer, tabId, captureMarkers, clearSentMarkers } = useSync();
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
    afterSignIn: () => {
      // Whatever this page believed about the server before signing in is not to be trusted
      // (the local copy may have been cleared by a sign-out in another tab).
      serverRevision.current = 0;
      return pullFromServer(true);
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
  const draggingIdRef = useRef("");
  const dragScopeRef = useRef("");
  const dragTargetRef = useRef("");
  const pointerDragRef = useRef({ id: "", startX: 0, startY: 0, active: false });
  const calendarLoadVersion = useRef(0);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const moreDialogRef = useRef<HTMLDivElement>(null);
  const contextClaimLoadVersion = useRef(0);
  const contextHistoryLoadVersion = useRef(0);
  const contextShortcut = useRef<{ active: boolean; run: (action: "undo" | "redo") => void }>({ active: false, run: () => undefined });
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
  async function inspect(e: Entity) {
    setSelected(e);
    setContext(await buildContext(e.id, 2));
  }
  function closeDetail() {
    setSelected(null);
    setContext(null);
  }
  async function askAI(promptOverride?: string) {
    const prompt = typeof promptOverride === "string" ? promptOverride.trim() : aiText.trim();
    if (!prompt || aiBusy) return;
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
      if (!response.ok) throw new Error(localizeServerError(result.error, tr) || tr("assistantRequestFailed"));
      setMessages([...history, {
        role: "assistant",
        content: result.message,
        proposal: result.proposal,
      }]);
    } catch (error) {
      setMessages([...history, {
        role: "assistant",
        // A request that did not reach the server (no connection) is said in the interface
        // language, not with the browser's own message.
        content: error instanceof TypeError ? tr("assistantOffline") : error instanceof Error ? error.message : tr("assistantRequestFailed"),
      }]);
    } finally {
      setAiBusy(false);
    }
  }

  async function resolveAIProposal(proposalId: string, action: "confirm" | "cancel") {
    if (aiBusy) return;
    setAiBusy(true);
    try {
      const response = await fetch("/api/ai/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, proposalId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizeServerError(result.error, tr) || tr("aiActionFailed"));
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
      setMessages((current) => [...current, {
        role: "assistant",
        content: error instanceof Error ? error.message : tr("aiActionFailed"),
      }]);
    } finally {
      setAiBusy(false);
    }
  }

  async function undoAIAction(actionId: string) {
    if (aiBusy) return;
    setAiBusy(true);
    try {
      const response = await fetch("/api/ai/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "undo", actionId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizeServerError(result.error, tr) || tr("undoFailed"));
      setMessages((current) => [
        ...current.map((message) => message.actionId === actionId ? { ...message, resolved: true } : message),
        { role: "assistant", content: result.message },
      ]);
      await pullFromServer();
    } catch (error) {
      setMessages((current) => [...current, {
        role: "assistant",
        content: error instanceof Error ? error.message : tr("undoFailed"),
      }]);
    } finally {
      setAiBusy(false);
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
  async function contextHistoryAction(action: "undo" | "redo" | "skip") {
    const workspaceId = calendarWorkspaceSelection.current;
    const skipping = action === "skip" ? historySkip : null;
    if (action === "skip" && !skipping) return;
    const side = skipping ? skipping.stack : action as "undo" | "redo";
    const step = skipping ? { eventId: skipping.eventId } : side === "undo" ? contextHistory.undo : contextHistory.redo;
    const busyKey = `history:${workspaceId}`;
    if (!step || contextInFlight.current.has(busyKey)) return;
    const scope = `history:${action}:${side}:${workspaceId}`;
    const intent = contextIntent(scope, JSON.stringify([workspaceId, action, side, step.eventId]));
    contextInFlight.current.add(busyKey);
    setHistoryBusy(true); setHistoryStatus(""); setHistoryOffer(""); setHistorySkip(null);
    // The result of this action replaces what an earlier command said about itself.
    setClaimStatus(""); setSubjectStatus(""); setContextInboxStatus("");
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
      setContextHistory({ undo: data.undo ?? null, redo: data.redo ?? null, recent: Array.isArray(data.recent) ? data.recent : [] });
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
    }
  }
  // A claim whose revision moved because its evidence changed: the editor keeps the draft and follows the revision.
  const syncEditedClaim = (claim: ContextClaimItem) => { if (claimEditor.current.objectId === claim.id) setEditingClaim(claim); };
  const evidenceState = useContextEvidence({ authState, activeWorkspaceId, writeWorkspaceId, tr, calendarWorkspaceSelection, contextIntent, finishContextIntent,
    contextInFlight, commandFailureMessage, refreshAfterCommand, offerContextUndo, loadContextClaims, syncEditedClaim });
  const { loadContextSources } = evidenceState;
  contextShortcut.current = { active: view === "Context" && !capture && !assistantOpen && !moreOpen && authState === "ready", run: (action) => { void contextHistoryAction(action); } };

  async function previewContextInbox() {
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
    setContextHistory({ undo: null, redo: null, recent: [] });
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
    if (savedView && views.includes(savedView)) {
      setStartupView(savedView);
      setView(savedView);
    }
    // A view named in the address wins over the start view.
    const addressedView = viewFromSearch(window.location.search, addressableViews);
    if (addressedView) setView(addressedView);
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
      await finishInterruptedWipe();
      // Given up once the access check finds no connection, so a stalled request does not keep the
      // offline view empty: the data kept in this browser is shown instead (catch below).
      const storeRequest = new AbortController();
      startupStoreRequest.current = storeRequest;
      if (authStateRef.current === "unavailable") storeRequest.abort();
      try {
        const response = await fetch("/api/store", { cache: "no-store", signal: storeRequest.signal });
        if (!response.ok) throw new Error("Server synchronization failed");
        let snapshot = (await response.json()) as ServerSnapshot;
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
          );
          if (saveResponse.status === 409) {
            snapshot = (await saveResponse.json()) as ServerSnapshot;
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
            );
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
        setSyncStatus("synced");
      } catch {
        await ensureDefaultWorkspace();
        await load();
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
        hasUnsent: hasUnsentChanges,
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
        wipe: () => clearLocalData().catch(() => undefined),
      });
      if (result !== "signed-out") {
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

  // A notification link names a task (?task=<id>). It is opened as soon as the task is known
  // locally. If it is not, the link waits for the first synchronization and is given up only
  // when the server copy does not contain the task either.
  useEffect(() => {
    if (deepLinkHandled.current || !items.length) return;
    const taskId = new URLSearchParams(window.location.search).get("task");
    if (taskId) {
      const task = items.find((item) => item.id === taskId);
      if (task && task.type !== "workspace") {
        selectWorkspace(task.workspaceId);
        inspect(task);
      } else if (authState !== "ready" || syncStatus !== "synced") {
        return;
      }
    }
    deepLinkHandled.current = true;
    setDeepLinkDone(true);
  }, [items, authState, syncStatus]);

  // The address follows the view: a change of view adds a history step, so Back and Forward move
  // between views and a reload stays where the user was. A record id from a notification link is
  // dropped from the address once the link has been handled. Nothing is recorded while signed out;
  // the offline view (started without a connection) shows the app, so it is recorded there too.
  const addressedView = useRef<string | null>(null);
  useEffect(() => {
    if (!addressReady || (authState !== "ready" && !offlineViewRef.current)) return;
    const hasRecordLink = new URLSearchParams(window.location.search).has("task");
    if (hasRecordLink && !deepLinkDone) return;
    const update = addressUpdate({ currentSearch: window.location.search, view, startView: startupView,
      navigated: addressedView.current !== null && addressedView.current !== view });
    addressedView.current = view;
    if (!update) return;
    const address = `${window.location.pathname}${update.search}`;
    try {
      if (update.mode === "push") window.history.pushState(null, "", address);
      else window.history.replaceState(null, "", address);
    } catch { /* browsers limit how often history may change; the view itself is unaffected */ }
  }, [addressReady, authState, deepLinkDone, view, startupView]);
  useEffect(() => {
    const followAddress = () => {
      const next = viewFromSearch(window.location.search, addressableViews) || localStorage.getItem("ai-executive-startup-view") || "Home";
      // Leaving a field commits what was typed in it, as closing the panel by hand would.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      addressedView.current = next;
      setView(views.includes(next) || next === "Settings" ? next : "Home");
      // Nothing that belongs to the view being left may stay open over the next one.
      answerConfirm(false);
      setCapture(false);
      setAssistantOpen(false);
      setMoreOpen(false);
      closeDetail();
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
    return () => moreTriggerRef.current?.focus();
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
        ?.setAttribute("content", resolved === "dark" ? "#1c1c1e" : "#f4f3f1");
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

  // The suggestion for Quick Capture depends on the text and where the task goes, not on every
  // reload of the local copy: a reload (a save, another tab, another device) must not restart it,
  // which would disable the add button for a moment and could swallow a click on it.
  const captureItemsRef = useRef(items);
  captureItemsRef.current = items;
  const captureProjectWorkspaceId = (captureProjectId && items.find((item) => item.id === captureProjectId)?.workspaceId) || "";
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
    const workspaceId = captureProjectWorkspaceId || writeWorkspaceId;
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
  }, [capture, captureType, draft, activeWorkspaceId, writeWorkspaceId, captureProjectId, captureProjectWorkspaceId, language, captureServerUnavailable]);

  async function saveWorkspaceName() {
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
    setActiveWorkspaceId(workspaceId);
    if (workspaceId !== "all") selectWriteWorkspace(workspaceId);
    localStorage.setItem("ai-executive-active-workspace", workspaceId);
    setMessages([]);
    setAiText("");
    setWorkspaceMenuOpen(false);
    closeDetail();
  }

  function selectWriteWorkspace(workspaceId: string) {
    setWriteWorkspaceId(workspaceId);
    localStorage.setItem("ai-executive-write-workspace", workspaceId);
  }

  // A manual area choice in quick capture; a later suggestion no longer replaces it.
  function chooseCaptureArea(areaId: string) {
    captureAreaTouched.current = true;
    setCaptureAreaId(areaId);
  }
  function selectCaptureWriteWorkspace(workspaceId: string) {
    // A manual choice belongs to the prior workspace. New suggestions may now fill the area.
    setCaptureAreaId("");
    captureAreaTouched.current = false;
    captureSuggestionVersion.current += 1;
    setCaptureSuggestion(null);
    setCaptureProjectAction("none");
    selectWriteWorkspace(workspaceId);
  }

  async function createWorkspace() {
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
  const { notificationState, setNotificationState, notificationStatus, enableNotifications, disableNotifications,
    testNotification, saveNotificationSettings } = useNotifications({ tr, language });
  const calendarTimezone = notificationState?.preferences.timezone || "Europe/Prague";
  const calendarTodayParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: calendarTimezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(badgeNow)).map((part) => [part.type, part.value]));
  const calendarToday = `${calendarTodayParts.year}-${calendarTodayParts.month}-${calendarTodayParts.day}`;
  const dayPlanState = useDayPlan({ authState, activeWorkspaceId, writeWorkspaceId, items, language, tr, calendarToday,
    calendarWorkspaceSelection, askConfirm, closeDetail, pullFromServer, selectWorkspace, syncQueue, pendingKey });
  const { applyDayPlanAction, currentDayPlanBlock, dayPlanBusy, dayPlanStatus, dayPlanTimeline, dayPlanUndo, dayPlanWhy, loadDayPlan, nextDayPlanBlock, setDayPlanNow, setDayPlanStatus, undoDayPlanBlock, visibleDayPlan, workElapsedText, workOverrun, workSession, workSessionAction, workSessionBusy, workSessionStatus } = dayPlanState;
  const { passkeys, passkeyLabel, setPasskeyLabel, passkeyPassword, setPasskeyPassword, passkeyStatus, registerPasskey,
    removePasskey } = usePasskeys({ view, authState, tr, language, askConfirm, setPasskeyBusy });
  const { backups, setBackups, backupStatus, setBackupStatus, createServerBackup, restoreServerBackup } = useBackups({
    language, tr, askConfirm, applySnapshot, afterRestore: () => { dropNotesBeingTyped(); postToTabs({ type: "restored", from: tabId.current }); } });
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
  const attentionState = useAttention({ authState, offlineView, activeWorkspaceId, syncStatus, items, pendingDeletedIds, tr, language, signingOut: () => signedOut.current || document.body.inert });
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
  const todayCalendarEvents = calendarEvents.filter((event) => Date.parse(event.end) > dayStart && Date.parse(event.start) < dayEnd);
  const calendarFresh = calendarSources.length > 0 && calendarSources.every((source) =>
    source.status === "ready" && source.lastSuccessAt !== null &&
    calendarFreshNow >= source.lastSuccessAt && calendarFreshNow - source.lastSuccessAt <= 30 * 60_000,
  );
  const nearbyCalendarEvents = calendarEvents
    .filter((event) => Date.parse(event.end) > calendarFreshNow && Date.parse(event.start) < calendarFreshNow + 7 * 24 * 60 * 60_000)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const mergedBusy = todayCalendarEvents.filter((event) => event.busy).map((event) => [
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
  const homeTodayTasks = tasks
    .filter((task) => taskMatchesView(task, "Today", today))
    .sort(byManualOrder("task:Today"))
    .slice(0, 5);
  const greetingHour = new Date().getHours();
  const homeGreeting = greetingHour < 12 ? tr("goodMorning") : greetingHour < 18 ? tr("goodAfternoon") : tr("goodEvening");
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
        return String(a.properties.when || "9999-12-31").localeCompare(String(b.properties.when || "9999-12-31"));
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
  ) {
    if (!title.trim()) return;
    const now = writeTime(),
      id = typeof extra.entityId === "string" ? extra.entityId : crypto.randomUUID(),
      projectId = typeof extra.projectId === "string" ? extra.projectId : "",
      areaId = typeof extra.areaId === "string" ? extra.areaId : "",
      newProjectTitle = typeof extra.newProjectTitle === "string" ? extra.newProjectTitle.trim() : "",
      properties = { ...extra },
      parsed =
        type === "task"
          ? parseCapture(title)
          : { title: title.trim(), when: "", priority: "none" };
    const linkedProject = projectId ? await db.entities.get(projectId) : null;
    const linkedArea = areaId ? await db.entities.get(areaId) : null;
    if (projectId && (!linkedProject || linkedProject.type !== "project" || linkedProject.status !== "active")) {
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
        await db.entities.add({
          id: createdProjectId,
          type: "project",
          title: newProjectTitle,
          status: "active",
          workspaceId: creationWorkspaceId,
          properties: {},
          createdAt: now,
          updatedAt: now,
        });
        if (areaId) {
          await db.relations.add({
            id: crypto.randomUUID(),
            workspaceId: creationWorkspaceId,
            sourceEntityId: createdProjectId,
            targetEntityId: areaId,
            relationType: "belongs_to_area",
            createdAt: now,
          });
        }
      }
      await db.entities.add({
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
      });
      created = true;
      if (projectId || createdProjectId) {
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: creationWorkspaceId,
          sourceEntityId: id,
          targetEntityId: projectId || createdProjectId,
          relationType: "belongs_to_project",
          createdAt: now,
        });
      }
      if (areaId) {
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: creationWorkspaceId,
          sourceEntityId: id,
          targetEntityId: areaId,
          relationType: "belongs_to_area",
          createdAt: now,
        });
      }
    });
    } finally {
      // Also when the write is refused: an odd version means "a write is in progress".
      localDataVersion.current += 1;
    }
    if (!created) return id;
    setText("");
    setDraft("");
    // The IndexedDB transaction above is the local-first commit boundary. Once it
    // succeeds, a network or refresh failure must not reopen Quick Capture and let
    // a retry duplicate the task/project pair. syncToServer keeps pendingKey set
    // on failure, so focus/online recovery can safely retry the same snapshot.
    try {
      await syncToServer();
      await load();
      if (selected) {
        setSelected((await db.entities.get(selected.id)) || null);
        setContext(await buildContext(selected.id, 2));
      }
    } catch {
      setSyncStatus("offline");
      await load().catch(() => undefined);
    }
    return id;
  }

  function openCapture(type: "task" | "note" = "task", projectId = "") {
    captureOpener.current = document.activeElement as HTMLElement | null;
    setCaptureType(type);
    setCaptureProjectId(projectId);
    setCaptureAreaId("");
    captureAreaTouched.current = false;
    setDraft("");
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
    const destinationWorkspaceId = (captureProjectId && items.find((item) => item.id === captureProjectId)?.workspaceId) || writeWorkspaceId;
    const suggestedAreaId = items.some((item) => item.id === captureAreaId && item.type === "area" && item.workspaceId === destinationWorkspaceId)
      ? captureAreaId
      : "";
    const suggestedDate = parsed.when || suggestion?.scheduledDate || "";
    const globalTask = captureType === "task" && !captureProjectId;
    setCapture(false);
    if (!captureProjectId && activeWorkspaceId !== "all" && activeWorkspaceId !== writeWorkspaceId) {
      setActiveWorkspaceId(writeWorkspaceId);
      localStorage.setItem("ai-executive-active-workspace", writeWorkspaceId);
    }
    if (globalTask) {
      closeDetail();
      setMoreOpen(false);
      setView(suggestedDate === today ? "Today" : "Inbox");
    }
    try {
      await create(captureType, title, {
        ...(suggestedProjectId ? { projectId: suggestedProjectId } : {}),
        ...(suggestedNewProjectTitle ? { newProjectTitle: suggestedNewProjectTitle } : {}),
        ...(suggestedAreaId ? { areaId: suggestedAreaId } : {}),
        ...(captureType === "task"
          ? {
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
      });
    } catch (error) {
      console.error(error);
      if (error instanceof Error && error.message === "PROJECT_ALREADY_EXISTS" && captureSuggestion?.newProjectSuggestion) {
        const workspaceId = writeWorkspaceId;
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
    if (!fresh) return;
    // Compared by content: a merged record can keep the timestamp it had.
    const shown = { ...fresh, title: titleEdited.current ? selected.title : fresh.title };
    if (JSON.stringify(shown) === JSON.stringify(selected)) return;
    setSelected((open) => (open && open.id === fresh.id ? { ...fresh, title: titleEdited.current ? open.title : fresh.title } : open));
  }, [items]);
  // The add row is shared by every list; its message belongs to the list it was shown under.
  useEffect(() => setRowError(false), [view]);
  // The add row under a list: a refused item keeps its text and says so instead of failing silently.
  async function createFromRow(type: EntityType, title: string) {
    setRowError(false);
    try {
      await create(type, title);
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
  ) {
    const source = await db.entities.get(sourceId);
    const target = targetId ? await db.entities.get(targetId) : null;
    if (!source || source.type === "workspace") return;
    if (targetId && !target) throw new Error("The selected relation target no longer exists");
    if (target && target.workspaceId !== source.workspaceId) {
      throw new Error("Cross-workspace relations are not allowed");
    }
    const existing = await db.relations
      .where("sourceEntityId")
      .equals(sourceId)
      .filter((r) => r.relationType === relationType)
      .toArray();
    localDataVersion.current += 1;
    const relationTimestamp = writeTime();
    await db.transaction("rw", db.entities, db.relations, async () => {
      await db.relations.bulkDelete(existing.map((r) => r.id));
      if (targetId)
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: source.workspaceId,
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          relationType,
          createdAt: relationTimestamp,
        });
      await db.entities.update(source.id, {
        properties: {
          ...source.properties,
          relationsUpdatedAt: relationTimestamp,
        },
        updatedAt: relationTimestamp,
      });
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    if (selected) {
      setSelected((await db.entities.get(selected.id)) || null);
      setContext(await buildContext(selected.id, 2));
    }
  }
  // `seq`: the count of key presses in the title when the save started (see titleEditSeq). If more
  // was typed meanwhile, the open detail keeps what is being typed.
  async function rename(e: Entity, title: string, seq?: number) {
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
      if (!saved) return null;
      const typedSince = seq !== undefined && titleEditSeq.current !== seq;
      return open && open.id === saved.id && typedSince ? { ...saved, title: open.title } : saved;
    });
  }
  async function remove(e: Entity) {
    const linkedRelations = (await db.relations.toArray()).filter(
      (relation) => relation.sourceEntityId === e.id || relation.targetEntityId === e.id,
    );
    localDataVersion.current += 1;
    await db.transaction("rw", db.entities, db.relations, async () => {
      await db.entities.delete(e.id);
      await db.relations.bulkDelete(linkedRelations.map((relation) => relation.id));
    });
    localDataVersion.current += 1;
    recordDeleted(localStorage, e.id);
    setUndo(e);
    setUndoRelations(linkedRelations);
    await syncToServer();
    closeDetail();
    load();
  }
  async function setProjectStatus(project: Entity, status: "active" | "completed") {
    if (project.type !== "project") return;
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
    await syncToServer();
    await load();
    setSelected((await db.entities.get(project.id)) || null);
  }
  async function restore() {
    if (!undo) return;
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
    await syncToServer();
    setUndo(null);
    setUndoRelations([]);
    load();
  }
  // `onlyIfOpen`: put the saved record into the detail panel only while that record is still the
  // one open there (a save that finishes after the panel was closed must not reopen it).
  // `properties` may be a function of the stored properties, for a change that depends on them
  // (a checklist item ticked): it is then computed from the stored record, not from what is shown.
  async function patch(e: Entity, properties: Record<string, unknown> | ((stored: Record<string, unknown>) => Record<string, unknown>), action = "updated", onlyIfOpen = false) {
    localDataVersion.current += 1;
    // Reading and writing in one transaction: two saves of the same record started together (for
    // example leaving the notes field by ticking a checklist item) must not overwrite each other.
    // The write marker is released even if the write fails (sign-out waits for it).
    try { await db.transaction("rw", db.entities, async () => {
      const current = (await db.entities.get(e.id)) || e;
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
    if (onlyIfOpen) setSelected((open) => (open && saved && open.id === e.id ? { ...saved, title: open.title !== e.title ? open.title : saved.title } : open));
    else setSelected(saved);
  }
  // Notes are typed into a draft and saved when the field is left. Saving on every key press put
  // the stored value back into the field while the save was running, so typed characters were
  // lost. Every key press also keeps the draft in the device (lib/notes-drafts.ts), because that
  // write is synchronous and survives the page being closed or killed before the save could run.
  // The draft is dropped only if nothing was typed into it since this save started. If the save
  // fails the draft stays, so the text is still in the field and is saved next time.
  const pageId = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // A restored backup replaced the data the notes were typed against: the draft is dropped here
  // and in the device, so it is neither shown nor saved over the restored notes.
  function dropNotesBeingTyped() {
    setNotesDraft(null);
    try { clearPageNotesDrafts(localStorage, pageId.current); } catch { /* storage unavailable */ }
  }
  const dropNotesBeingTypedRef = useRef(dropNotesBeingTyped);
  dropNotesBeingTypedRef.current = dropNotesBeingTyped;
  function editNotes(id: string, text: string, base: string) {
    setNotesDraft({ id, text });
    keepNotesDraft(localStorage, pageId.current, id, text, base);
  }
  async function saveNotes(e: Pick<Entity, "id">, notes: string) {
    try {
      const stored = await db.entities.get(e.id);
      if (stored && String(stored.properties.notes || "") !== notes) await patch(stored, { notes }, "updated", true);
    } catch {
      return;
    }
    setNotesDraft((draft) => (draft && draft.id === e.id && draft.text === notes ? null : draft));
    settleNotesDraft(localStorage, pageId.current, e.id, notes);
  }
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
      if (message.type === "restored") { dropNotesBeingTypedRef.current(); return; }
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
  // Drafts left by other pages. A page that is still open answers on the draft channel while it
  // holds a draft, and its drafts are left to it.
  const draftChannelName = "ai-executive-notes-draft";
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(draftChannelName);
    channel.onmessage = (event) => {
      if (event.data?.ask === pageId.current && notesDraftRef.current) channel.postMessage({ alive: pageId.current });
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
      const stored = await db.entities.get(draft.id);
      if (stopped()) return leftToOwner;
      const action = leftoverDraftAction(draft, stored ? String(stored.properties.notes || "") : undefined);
      if (action === "conflict" && signingOut) continue;
      if (action === "save" && stored) {
        try {
          await patch(stored, { notes: draft.text }, "updated", true);
        } catch {
          continue;
        }
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
    }, `scheduled ${destination}`);
  }
  async function done(id: string) {
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
    closeDetail();
    load();
  }
  async function reopenTask(task: Entity) {
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
    setSelected((await db.entities.get(task.id)) || null);
  }
  const type: EntityType =
    view === "Projects"
      ? "project"
      : view === "Areas"
        ? "area"
        : view === "Notes"
          ? "note"
          : "task";
  const collection = ["Projects", "Areas", "Notes"].includes(view)
    ? scopedItems.filter((x) => x.type === type).sort(byManualOrder(`${type}:all`))
    : visible;
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

  async function persistManualOrder(ordered: Entity[], movedId: string, scope: string) {
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
    const source = items.find((entity) => entity.id === sourceId);
    if (!source || !target) return;
    if (target.startsWith("section:")) {
      await moveTaskToSection(source, target.slice("section:".length));
      return;
    }
    if (!target.startsWith("entity:")) return;
    const targetEntity = items.find((entity) => entity.id === target.slice("entity:".length));
    if (!targetEntity || targetEntity.id === source.id || targetEntity.workspaceId !== source.workspaceId) return;
    if (source.type === targetEntity.type) {
      const peers = peersForScope(scope, source.workspaceId);
      const sourceIndex = peers.findIndex((entity) => entity.id === source.id);
      const targetIndex = peers.findIndex((entity) => entity.id === targetEntity.id);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const [moved] = peers.splice(sourceIndex, 1);
      const insertionIndex = peers.findIndex((entity) => entity.id === targetEntity.id);
      peers.splice(insertionIndex + (sourceIndex < targetIndex ? 1 : 0), 0, moved);
      if (source.type === "task") setSortBy("manual");
      await persistManualOrder(peers, source.id, scope);
      return;
    }
    if ((source.type === "task" || source.type === "note") && targetEntity.type === "project") {
      await relate(source.id, targetEntity.id, "belongs_to_project");
    } else if (source.type === "project" && targetEntity.type === "area") {
      await relate(source.id, targetEntity.id, "belongs_to_area");
    } else if (source.type === "task" && targetEntity.type === "area") {
      await relate(source.id, targetEntity.id, "belongs_to_area");
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
    const peers = view === "Home" && scope === "task:Today" ? homeTodayTasks
        : scope === `task:${view}` ? collection.filter((candidate) => candidate.workspaceId === entity.workspaceId)
          : peersForScope(scope, entity.workspaceId);
    const index = peers.findIndex((candidate) => candidate.id === entity.id);
    const target = peers[index + direction];
    if (index < 0 || !target) return;
    await completeDrop(entity.id, `entity:${target.id}`, scope);
  }

  const dragHandle = (entity: Entity, scope: string) => (
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
    ...attentionState,
    ...evidenceState,
    claimEffectivePredicate,
    claimRelationOptions,
    claimSubjectType,
    claimTargetType,
    providerLabel,
    relationLabel,
    setDayPlanNow,
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
    calendarTimezone,
    calendarToday,
    calendarUrl,
    calendarWorkspaceSelection,
    capture,
    captureModalRef,
    captureProjectAction,
    captureProjectId,
    captureAreaId,
    chooseCaptureArea,
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
    homeGreeting,
    homeTodayTasks,
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
    nearbyCalendarEvents,
    newSubjectTitle,
    newSubjectType,
    newWorkspaceDraft,
    notesDraft,
    notificationState,
    notificationStatus,
    openCapture,
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
    testAppBadge,
    testNotification,
    text,
    themeMode,
    today,
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
    workspaces,
    writeWorkspace,
    writeWorkspaceId,
  };
}

export type LumiApp = ReturnType<typeof useLumiApp>;
