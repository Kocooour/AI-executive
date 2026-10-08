"use client";
import { type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { db, ensureDefaultWorkspace, migratePropertyRelations, personalWorkspaceId, seed, type Entity, type EntityType, type Relation } from "../../lib/db";
import { clearLocalData, finishInterruptedWipe, hasUnsentChanges } from "../../lib/local-data";
import { runSignOut } from "../../lib/sign-out";
import { dropNotesDraft, keepNotesDraft, keptNotesDrafts, leftoverDraftAction, settleNotesDraft, type KeptNotesDraft } from "../../lib/notes-drafts";
import { addressUpdate, viewFromSearch } from "../../lib/view-url";
import { buildContext, type ContextBundle } from "../../lib/context";
import { mergeSnapshots, type ServerSnapshot } from "../../lib/server-sync";
import { fetchClientAuthStatus } from "../../lib/client-auth-status";
import { addLocalDays, fromLocalDateTime, toLocalDateTime, ymd, zonedDateTimeToIso } from "../../lib/local-dates";
import { byManualOrder, manualOrder, newTaskPlacement, parseCaptureText, taskMatchesView } from "../../lib/task-views";
import { findActiveProjectWithTitle } from "../../lib/project-title";
import { type AIProposal, type AssistantMessage, type CalendarEvent, type CalendarSourceState, type CaptureProjectAction, type CaptureSuggestion, type ConfirmRequest, type ContextClaimItem, type ContextInboxProposal, type ContextInboxTaskDraft, type DayPlanItem, type DurableContextItem, type Language, type NotificationState, type PACTAgentResult, type PACTAgentRunSummary, type PACTAgentSummary, type StandaloneSubjectItem, type ThemeMode } from "./types";
import { copy } from "./copy";
import { views } from "./navigation";
import { useAttention } from "./hooks/use-attention";
import { useDayPlan } from "./hooks/use-day-plan";
import { useBackups } from "./hooks/use-backups";
import { usePasskeys } from "./hooks/use-passkeys";
import { useSignIn } from "./hooks/use-sign-in";
import { useNotifications } from "./hooks/use-notifications";
import { useAppBadge } from "./hooks/use-app-badge";
import { useSync } from "./hooks/use-sync";

// All client state, effects and handlers of the Lumi app shell, moved verbatim from app/page.tsx.
// Views receive the returned object as `app` and destructure what they render.
export function useLumiApp() {
  const [view, setView] = useState("Home"),
    [text, setText] = useState(""),
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
    [claimHistory, setClaimHistory] = useState<Record<string, Array<{ operation: string; beforeRevision: number | null; afterRevision: number; createdAt: number }>>>({}),
    [standaloneSubjects, setStandaloneSubjects] = useState<StandaloneSubjectItem[]>([]),
    [subjectSearch, setSubjectSearch] = useState(""),
    [newSubjectTitle, setNewSubjectTitle] = useState(""),
    [newSubjectType, setNewSubjectType] = useState<"person" | "organization">("person"),
    [subjectBusy, setSubjectBusy] = useState(false),
    [subjectStatus, setSubjectStatus] = useState(""),
    [subjectEditId, setSubjectEditId] = useState(""),
    [subjectEditTitle, setSubjectEditTitle] = useState(""),
    [subjectHistory, setSubjectHistory] = useState<Record<string, Array<{ operation: string; beforeRevision: number | null; afterRevision: number; beforeTitle: string | null; afterTitle: string | null; createdAt: number }>>>({}),
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
    [claimSourceProvider, setClaimSourceProvider] = useState(""),
    [claimSourceLocator, setClaimSourceLocator] = useState(""),
    [claimEvidence, setClaimEvidence] = useState(""),
    [editingClaim, setEditingClaim] = useState<ContextClaimItem | null>(null),
    [claimStatus, setClaimStatus] = useState(""),
    [claimBusyId, setClaimBusyId] = useState(""),
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
  const { items, relations, syncStatus, setSyncStatus, serverRevision, syncQueue, localDataVersion, signedOut, pendingKey,
    deletedKey, revivedKey, pendingDeletedIds, pendingRevivedIds, load, applySnapshot, putSnapshot, syncToServer,
    pullFromServer } = useSync();
  const tr = (key: string) => copy[language][key] || key;
  const { authState, setAuthState, authStateRef, authEnabled, authPassword, setAuthPassword, authError, authNotice,
    sessionEndedHere, checkAccess, login, signInWithPasskey, passkeySupported, passkeyBusy, setPasskeyBusy } = useSignIn({
    tr,
    answerConfirm,
    isSignedOut: () => signedOut.current,
    afterSignIn: () => {
      // Whatever this page believed about the server before signing in is not to be trusted
      // (the local copy may have been cleared by a sign-out in another tab).
      serverRevision.current = 0;
      return pullFromServer(true);
    },
  });
  const contextPredicateLabel = (predicate: string) => {
    const labels: Record<string, [string, string]> = {
      waiting_for: ["Na výsledek čeká", "Waiting for result"],
      responsible_for: ["Odpovídá za", "Responsible for"],
      works_for: ["Pracuje pro", "Works for"],
      participates_in: ["Účastní se", "Participates in"],
      assigned_to: ["Přiřazeno", "Assigned to"],
      blocked_by: ["Blokuje", "Blocked by"],
      related_to: ["Souvisí s", "Related to"],
      create: ["Vytvořeno", "Created"], rename: ["Přejmenováno", "Renamed"], archive: ["Archivováno", "Archived"],
      update: ["Upraveno", "Updated"], review: ["Zkontrolováno", "Reviewed"],
    };
    return labels[predicate]?.[language === "cs" ? 0 : 1] || predicate;
  };
  const contextSubjectTypeLabel = (type: string) => {
    if (type === "person") return language === "cs" ? "Osoba" : "Person";
    if (type === "organization") return language === "cs" ? "Organizace" : "Organization";
    return tr(type);
  };
  const contextInboxReason = (reason: ContextInboxProposal["reason"] | ContextInboxTaskDraft["reason"]) => ({
    waiting: language === "cs" ? "Text zmiňuje osobu nebo stranu čekající na výsledek." : "The text mentions a person or party waiting for the result.",
    importance: language === "cs" ? "Text výslovně popisuje prioritu nebo důležitost." : "The text explicitly describes priority or importance.",
    deadline: language === "cs" ? "Text obsahuje výslovný termín." : "The text contains an explicit deadline.",
    preference: language === "cs" ? "Text obsahuje preferenci nebo omezení." : "The text contains a preference or constraint.",
    action_item: language === "cs" ? "Řádek vypadá jako akční položka. Před vytvořením jej zkontrolujte v rychlém zadání." : "This line looks like an action item. Review it in Quick Capture before creating it.",
  })[reason];
  const taskDraftCaptureText = (task: ContextInboxTaskDraft) => {
    const localDate = task.suggestedDate
      ? `${Number(task.suggestedDate.slice(8, 10))}.${Number(task.suggestedDate.slice(5, 7))}.${task.suggestedDate.slice(0, 4)}`
      : "";
    const priority = task.suggestedPriority === "high" ? "!" : task.suggestedPriority === "medium" ? "#medium" : task.suggestedPriority === "low" ? "#low" : "";
    return [task.title, priority, localDate].filter(Boolean).join(" ");
  };
  const deepLinkHandled = useRef(false);
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
  const calendarWorkspaceSelection = useRef("personal");
  calendarWorkspaceSelection.current = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
  // One confirmation at a time: asking again answers the previous question with "no".
  const confirmResolver = useRef<((confirmed: boolean) => void) | null>(null);
  function askConfirm(request: ConfirmRequest) {
    confirmResolver.current?.(false);
    // The dialog lives in the signed-in screen; without it a question could never be answered.
    if (authStateRef.current !== "ready") return Promise.resolve(false);
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
      if (!response.ok) throw new Error(result.error || "Assistant request failed.");
      setMessages([...history, {
        role: "assistant",
        content: result.message,
        proposal: result.proposal,
      }]);
    } catch (error) {
      setMessages([...history, {
        role: "assistant",
        content: error instanceof Error ? error.message : "Assistant request failed.",
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
      if (!response.ok) throw new Error(result.error || "AI action failed.");
      setMessages((current) => [
        ...current.map((message) =>
          message.proposal?.id === proposalId || (action === "confirm" && message.actionId)
            ? { ...message, resolved: true }
            : message,
        ),
        {
          role: "assistant",
          content: action === "confirm" ? result.message : "Návrh jsem zahodil. Nic se nezměnilo.",
          actionId: result.actionId,
        },
      ]);
      if (action === "confirm") await pullFromServer();
    } catch (error) {
      setMessages((current) => [...current, {
        role: "assistant",
        content: error instanceof Error ? error.message : "AI action failed.",
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
      if (!response.ok) throw new Error(result.error || "Undo failed.");
      setMessages((current) => [
        ...current.map((message) => message.actionId === actionId ? { ...message, resolved: true } : message),
        { role: "assistant", content: result.message },
      ]);
      await pullFromServer();
    } catch (error) {
      setMessages((current) => [...current, {
        role: "assistant",
        content: error instanceof Error ? error.message : "Undo failed.",
      }]);
    } finally {
      setAiBusy(false);
    }
  }
  const contextScopeLoaded = useRef("");

  async function loadAgents(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const response = await fetch(`/api/executive?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Agents are unavailable");
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
      if (!response.ok) throw new Error(data.error || "Agent run failed");
      if (data.agentResult) setAgentResult(data.agentResult as PACTAgentResult);
      await loadAgents(workspaceId);
    } catch (error) {
      setAgentStatus(error instanceof Error ? error.message : "Agent run failed");
    } finally {
      setAgentBusyId("");
    }
  }

  async function loadCalendar(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const loadVersion = ++calendarLoadVersion.current;
    const from = Date.now() - 24 * 60 * 60_000;
    const to = Date.now() + 14 * 24 * 60 * 60_000;
    const response = await fetch(`/api/calendar?workspaceId=${encodeURIComponent(workspaceId)}&from=${from}&to=${to}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Calendar is unavailable");
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
      if (!response.ok) throw new Error(data.error || "Calendar action failed");
      setCalendarUrl("");
      await loadCalendar(workspaceId);
      await loadDayPlan(workspaceId, calendarToday);
      setCalendarStatus(action === "connect" ? "Kalendář je připojený pouze pro čtení." : action === "refresh" ? "Kalendář byl obnoven." : "Kalendář byl odpojen a jeho data odstraněna.");
    } catch (error) {
      setCalendarUrl("");
      await loadCalendar(workspaceId).catch(() => undefined);
      setCalendarStatus(error instanceof Error ? error.message : "Calendar action failed");
    } finally {
      setCalendarBusy(false);
    }
  }

  async function loadDurableContext(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const response = await fetch(`/api/context?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Context is unavailable");
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
      if (!response.ok) throw new Error(data.error || "Context action failed");
      if (action === "create") {
        setContextTitle(""); setContextContent(""); setContextProjectId("");
        setContextStatus(language === "cs" ? "Kontext byl uložen." : "Context saved.");
      }
      await loadDurableContext(workspaceId);
    } catch (error) {
      setContextStatus(error instanceof Error ? error.message : "Context action failed");
    } finally {
      setContextBusy(false);
    }
  }

  async function loadContextClaims(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const loadVersion = ++contextClaimLoadVersion.current;
    const response = await fetch(`/api/context/claims?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Context claims are unavailable");
    if (loadVersion !== contextClaimLoadVersion.current || calendarWorkspaceSelection.current !== workspaceId) return;
    setContextClaims(Array.isArray(data.claims) ? data.claims : []);
  }

  async function loadStandaloneSubjects(workspaceId = calendarWorkspaceSelection.current) {
    const response = await fetch(`/api/context/subjects?workspaceId=${encodeURIComponent(workspaceId)}&includeArchived=true`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "People and organizations are unavailable");
    if (calendarWorkspaceSelection.current === workspaceId) setStandaloneSubjects(Array.isArray(data.subjects) ? data.subjects : []);
  }

  async function subjectAction(action: "create" | "rename" | "archive", subject?: StandaloneSubjectItem) {
    if (subjectBusy) return;
    const workspaceId = calendarWorkspaceSelection.current;
    setSubjectBusy(true); setSubjectStatus("");
    try {
      const response = await fetch("/api/context/subjects", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, idempotencyKey: crypto.randomUUID(), workspaceId,
          id: subject?.id || crypto.randomUUID(), expectedRevision: subject?.revision || 0,
          type: newSubjectType, title: subject ? subjectEditTitle : newSubjectTitle }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.code === "duplicate_subject" ? (language === "cs" ? "Tato osoba nebo organizace už existuje. Vyberte ji ze seznamu." : "This person or organization already exists. Choose it from the list.") : data.error || "Subject action failed");
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      await loadStandaloneSubjects(workspaceId); await loadContextClaims(workspaceId);
      setNewSubjectTitle(""); setSubjectEditId(""); setSubjectEditTitle("");
      setSubjectStatus(language === "cs" ? "Uloženo." : "Saved.");
    } catch (error) { if (calendarWorkspaceSelection.current === workspaceId) setSubjectStatus(error instanceof Error ? error.message : "Subject action failed"); }
    finally { setSubjectBusy(false); }
  }

  async function showSubjectHistory(subject: StandaloneSubjectItem) {
    const workspaceId = calendarWorkspaceSelection.current;
    try {
      const response = await fetch(`/api/context/subjects?workspaceId=${encodeURIComponent(workspaceId)}&historyId=${encodeURIComponent(subject.id)}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "History unavailable");
      if (calendarWorkspaceSelection.current === workspaceId) setSubjectHistory((current) => ({ ...current, [subject.id]: Array.isArray(data.history) ? data.history : [] }));
    } catch (error) { setSubjectStatus(error instanceof Error ? error.message : "History unavailable"); }
  }

  async function reloadContextClaims() {
    const workspaceId = calendarWorkspaceSelection.current;
    setClaimStatus(language === "cs" ? "Načítám…" : "Reloading…");
    try {
      await loadContextClaims(workspaceId);
      if (calendarWorkspaceSelection.current === workspaceId) setClaimStatus(language === "cs" ? "Tvrzení byla obnovena; rozepsaný návrh zůstal zachován." : "Claims reloaded; your draft was preserved.");
    } catch (error) {
      if (calendarWorkspaceSelection.current === workspaceId) setClaimStatus(error instanceof Error ? error.message : "Context claims are unavailable");
    }
  }

  async function showClaimHistory(claim: ContextClaimItem) {
    const workspaceId = calendarWorkspaceSelection.current;
    try {
      const response = await fetch(`/api/context/claims?workspaceId=${encodeURIComponent(workspaceId)}&claimId=${encodeURIComponent(claim.id)}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Claim history unavailable");
      if (calendarWorkspaceSelection.current === workspaceId) setClaimHistory((current) => ({ ...current, [claim.id]: Array.isArray(data.history) ? data.history : [] }));
    } catch (error) { if (calendarWorkspaceSelection.current === workspaceId) setClaimStatus(error instanceof Error ? error.message : "Claim history unavailable"); }
  }

  function resetClaimDraft() {
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
    setClaimSourceProvider("");
    setClaimSourceLocator("");
    setClaimEvidence("");
  }

  function editContextClaim(claim: ContextClaimItem) {
    setEditingClaim(claim);
    setClaimSubjectId(claim.subject.canonicalEntityId || claim.subject.id);
    setClaimPredicate(claim.predicate);
    setClaimValue(String(claim.literal?.value ?? ""));
    setClaimValueType(claim.literal?.type || "string");
    setClaimValueMode(claim.target ? "target" : "literal");
    setClaimTargetId(claim.target?.id || "");
    setClaimFreshness(claim.freshness);
    setClaimSensitivity(claim.sensitivity);
    setClaimValidFrom(claim.validFrom || "");
    setClaimValidTo(claim.validTo || "");
    setClaimSourceProvider(claim.source?.provider || "");
    setClaimSourceLocator(claim.source?.locator || "");
    setClaimEvidence(claim.evidence?.excerpt || "");
    setClaimStatus("");
    window.setTimeout(() => document.getElementById("context-claim-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function saveContextClaim() {
    if (claimBusyId) return;
    const workspaceId = calendarWorkspaceSelection.current;
    const claimId = editingClaim?.id || crypto.randomUUID();
    setClaimBusyId(claimId);
    setClaimStatus(language === "cs" ? "Ukládám…" : "Saving…");
    try {
      const parsedValue = claimValueType === "number" ? Number(claimValue)
        : claimValueType === "boolean" ? claimValue === "true" : claimValue;
      const hasSource = Boolean(claimSourceProvider.trim() || claimSourceLocator.trim());
      const response = await fetch("/api/context/claims", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: editingClaim ? "update" : "create", idempotencyKey: crypto.randomUUID(), workspaceId,
          id: claimId, expectedRevision: editingClaim?.revision || 0,
          subject: editingClaim ? undefined : standaloneSubjects.some((subject) => subject.id === claimSubjectId)
            ? { subjectId: claimSubjectId } : { entityId: claimSubjectId },
          predicate: claimPredicate.trim(), literal: claimValueMode === "literal" ? { type: claimValueType, value: parsedValue } : undefined,
          target: claimValueMode === "target" ? (standaloneSubjects.some((subject) => subject.id === claimTargetId)
            ? { subjectId: claimTargetId } : { entityId: claimTargetId }) : undefined,
          freshness: claimFreshness, sensitivity: claimSensitivity,
          validFrom: claimValidFrom || null, validTo: claimValidTo || null,
          source: hasSource ? { provider: claimSourceProvider.trim() || undefined, locator: claimSourceLocator.trim() || undefined } : null,
          evidence: hasSource && claimEvidence.trim() ? { excerpt: claimEvidence.trim(), stance: "supports" } : null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409) throw new Error(language === "cs" ? "Konflikt: tvrzení se změnilo na jiném zařízení. Návrh zůstal zachován; použijte Obnovit tvrzení a potom otevřete aktuální verzi." : "Conflict: the claim changed on another device. Your draft was kept; use Reload claims, then open the current version.");
        throw new Error(data.error || "Context claim could not be saved");
      }
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      await loadContextClaims(workspaceId);
      resetClaimDraft();
      setClaimStatus(language === "cs" ? "Uloženo. Nové tvrzení čeká na kontrolu." : "Saved. A new claim awaits review.");
    } catch (error) {
      if (calendarWorkspaceSelection.current === workspaceId) {
        setClaimStatus(error instanceof Error ? error.message : "Context claim could not be saved");
      }
    } finally {
      setClaimBusyId("");
    }
  }

  async function contextClaimAction(claim: ContextClaimItem, action: "review" | "archive", decision?: ContextClaimItem["reviewStatus"]) {
    if (claimBusyId) return;
    const workspaceId = calendarWorkspaceSelection.current;
    setClaimBusyId(claim.id);
    setClaimStatus(language === "cs" ? "Ukládám…" : "Saving…");
    try {
      const response = await fetch("/api/context/claims", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, idempotencyKey: crypto.randomUUID(), workspaceId, id: claim.id,
          expectedRevision: claim.revision, decision }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409) throw new Error(language === "cs" ? "Konflikt: načtěte aktuální verzi tvrzení." : "Conflict: reload the current claim version.");
        throw new Error(data.error || "Context claim action failed");
      }
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      await loadContextClaims(workspaceId);
      setClaimStatus(language === "cs" ? "Uloženo." : "Saved.");
    } catch (error) {
      if (calendarWorkspaceSelection.current === workspaceId) {
        setClaimStatus(error instanceof Error ? error.message : "Context claim action failed");
      }
    } finally {
      setClaimBusyId("");
    }
  }

  async function previewContextInbox() {
    if (!contextInboxText.trim() || contextInboxBusy) return;
    const workspaceId = calendarWorkspaceSelection.current;
    setContextInboxBusy("preview"); setContextInboxStatus("");
    try {
      const response = await fetch("/api/context/inbox", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "preview", workspaceId, text: contextInboxText }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Context preview failed");
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      setContextInboxProposals(Array.isArray(data.proposals) ? data.proposals : []);
      setContextInboxTasks(Array.isArray(data.taskDrafts) ? data.taskDrafts : []);
      setContextInboxStatus(language === "cs" ? "Náhled je připravený. Původní text nebyl uložen." : "Preview ready. The original text was not stored.");
    } catch (error) { setContextInboxStatus(error instanceof Error ? error.message : "Context preview failed"); }
    finally { setContextInboxBusy(""); }
  }

  async function approveContextInbox(proposal: ContextInboxProposal) {
    if (contextInboxBusy) return;
    const workspaceId = calendarWorkspaceSelection.current;
    setContextInboxBusy(proposal.id); setContextInboxStatus("");
    try {
      const response = await fetch("/api/context/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        action: "approve", workspaceId, idempotencyKey: proposal.id, id: proposal.id,
        subjectId: proposal.subject.entityId, predicate: proposal.predicate,
        literal: proposal.suggestedTarget ? undefined : proposal.literal,
        targetSubjectId: proposal.suggestedTarget ? proposal.selectedTargetId : undefined,
        freshness: proposal.freshness, validFrom: proposal.validFrom,
        validTo: proposal.validTo, evidenceExcerpt: proposal.evidenceExcerpt,
      }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Context proposal could not be saved");
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      setContextInboxProposals((current) => current.filter((item) => item.id !== proposal.id));
      await loadContextClaims(workspaceId);
      setContextInboxStatus(language === "cs" ? "Návrh byl přidán do fronty ke kontrole." : "Proposal added to the review queue.");
    } catch (error) { if (calendarWorkspaceSelection.current === workspaceId) setContextInboxStatus(error instanceof Error ? error.message : "Context proposal could not be saved"); }
    finally { setContextInboxBusy(""); }
  }

  async function createSuggestedTarget(proposal: ContextInboxProposal) {
    if (!proposal.suggestedTarget || contextInboxBusy) return;
    const workspaceId = calendarWorkspaceSelection.current;
    setContextInboxBusy(proposal.id); setContextInboxStatus("");
    try {
      const id = crypto.randomUUID();
      const response = await fetch("/api/context/subjects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        action: "create", idempotencyKey: crypto.randomUUID(), workspaceId, id, expectedRevision: 0,
        type: proposal.suggestedTarget.type, title: proposal.suggestedTarget.title,
      }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.code === "duplicate_subject" ? (language === "cs" ? "Osoba už existuje; vyberte ji ze seznamu." : "Person exists; select them from the list.") : data.error || "Could not create person");
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      await loadStandaloneSubjects(workspaceId);
      setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, selectedTargetId: id } : item));
      setContextInboxStatus(language === "cs" ? "Osoba vytvořena. Vztah uložte samostatně ke kontrole." : "Person created. Save the relationship separately for review.");
    } catch (error) { if (calendarWorkspaceSelection.current === workspaceId) setContextInboxStatus(error instanceof Error ? error.message : "Could not create person"); }
    finally { setContextInboxBusy(""); }
  }

  useEffect(() => {
    if (authState !== "ready") return;
    loadAgents().catch(() => undefined);
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setCalendarSources([]);
    setCalendarEvents([]);
    loadCalendar(workspaceId).catch(() => undefined);
    loadDurableContext(workspaceId).catch(() => setContextStatus(language === "cs" ? "Kontext nelze načíst." : "Context is unavailable."));
    setContextClaims([]);
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
    loadContextClaims(workspaceId).catch(() => setClaimStatus(language === "cs" ? "Strukturovaný kontext nelze načíst." : "Structured context is unavailable."));
    loadStandaloneSubjects(workspaceId).catch(() => setSubjectStatus(language === "cs" ? "Osoby a organizace nelze načíst." : "People and organizations are unavailable."));
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
      try {
        const response = await fetch("/api/store", { cache: "no-store" });
        if (!response.ok) throw new Error("Server synchronization failed");
        let snapshot = (await response.json()) as ServerSnapshot;
        await ensureDefaultWorkspace();
        let localEntities = await db.entities.toArray();
        let localRelations = await db.relations.toArray();
        if (
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
        if (!alreadySynchronized || hasPendingChanges) {
          const deletedIds = new Set(pendingDeletedIds());
          const revivedIds = new Set(pendingRevivedIds());
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
          const merged = mergeSnapshots(
            filteredSnapshot,
            localEntities,
            localRelations,
          );
          let saveResponse = await putSnapshot(
            merged.entities,
            merged.relations,
            snapshot.revision,
            pendingDeletedIds(),
            pendingRevivedIds(),
          );
          if (saveResponse.status === 409) {
            snapshot = (await saveResponse.json()) as ServerSnapshot;
            const retrySnapshot = {
              ...snapshot,
              tombstones: (snapshot.tombstones || []).filter(
                (item) => !revivedIds.has(item.id),
              ),
            };
            const retry = mergeSnapshots(
              retrySnapshot,
              merged.entities,
              merged.relations,
            );
            saveResponse = await putSnapshot(
              retry.entities,
              retry.relations,
              snapshot.revision,
              pendingDeletedIds(),
              pendingRevivedIds(),
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
          await syncToServer();
          return;
        }
        await applySnapshot(snapshot, initializationVersion);
        if (localDataVersion.current !== initializationVersion) return;
        localStorage.setItem("ai-executive-server-synced", "1");
        localStorage.removeItem(pendingKey);
        localStorage.removeItem(deletedKey);
        localStorage.removeItem(revivedKey);
        setSyncStatus("synced");
      } catch {
        await ensureDefaultWorkspace();
        await load();
        setSyncStatus("offline");
      }
    }
    initialize();
  }, []);

  // Signing out removes the local copy of the data. Unsent changes are sent first; if that is not
  // possible the user decides whether to drop them. Without the server nothing is removed, because
  // the session cookie cannot be cleared from here.
  async function logout() {
    if (logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError("");
    let leaving = false;
    try {
      const result = await runSignOut({
        version: () => localDataVersion.current,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        drainSync: () => syncQueue.current,
        hasUnsent: hasUnsentChanges,
        // Notes drafts kept in the device go into the local copy first, so they are sent too.
        sync: async () => { await saveLeftoverDrafts(true); await syncToServer(); },
        serverReachable: () => fetch("/api/auth/status", { cache: "no-store" }).then((response) => response.ok).catch(() => false),
        confirmDiscard: () => askConfirm({ title: tr("signOutDiscardTitle"), message: tr("signOutDiscard"), confirmLabel: tr("signOutDiscardAction"), danger: true }),
        // From here nothing may be edited and no pull or sync still in flight may write data back.
        block: () => { signedOut.current = true; document.body.inert = true; },
        unblock: () => { signedOut.current = false; document.body.inert = false; },
        endSession: () => fetch("/api/auth/logout", { method: "POST" }).then((response) => (response.ok ? "ok" : "failed") as "ok" | "failed", () => "offline" as const),
        // If the wipe cannot finish now it stays marked and is completed when the page starts again.
        wipe: () => clearLocalData().catch(() => undefined),
      });
      if (result !== "signed-out") {
        setLogoutError(tr(result === "writing" ? "signOutBusy" : result === "offline" ? "signOutOffline" : result === "kept" ? "signOutKept" : "signOutFailed"));
        return;
      }
      leaving = true;
      try { const channel = new BroadcastChannel(sessionChannel); channel.postMessage("signed-out"); channel.close(); } catch { /* not supported */ }
      // A full reload drops everything still held in memory.
      window.location.replace("/");
    } finally {
      if (!leaving) setLogoutBusy(false);
    }
  }
  // The message is about a moment in time: drop it when the user moves on or the data is in sync again.
  useEffect(() => { setLogoutError(""); }, [view]);
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
  // dropped from the address once the link has been handled. Nothing is recorded while signed out.
  const addressedView = useRef<string | null>(null);
  useEffect(() => {
    if (!addressReady || authState !== "ready") return;
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
  }, [view, authState]);

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

  useEffect(() => {
    const parsed = parseCapture(draft);
    if (!capture || captureType !== "task" || parsed.title.length < 3) {
      captureSuggestionVersion.current += 1;
      setCaptureSuggestion(null);
      setCaptureSuggestionBusy(false);
      setCaptureSuggestionError("");
      return;
    }
    const version = ++captureSuggestionVersion.current;
    // A task added to a project goes to the project's workspace; its suggestions (area, calendar
    // window) have to come from there too.
    const workspaceId = (captureProjectId && items.find((item) => item.id === captureProjectId)?.workspaceId) || writeWorkspaceId;
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
        if (!response.ok) throw new Error(body.error || "Suggestion failed");
        if (captureSuggestionVersion.current !== version) return;
        const suggestion = body.suggestion as CaptureSuggestion;
        suggestion.newProjectSuggestion = suggestion.newProjectSuggestion || null;
        suggestion.scheduledOptions = Array.isArray(suggestion.scheduledOptions)
          ? suggestion.scheduledOptions
          : suggestion.scheduledStart
            ? [{ start: suggestion.scheduledStart, end: suggestion.scheduledEnd, date: suggestion.scheduledDate }]
            : [];
        if (captureProjectId) {
          const project = items.find((item) => item.id === captureProjectId && item.type === "project");
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
      } catch {
        if (captureSuggestionVersion.current === version) {
          setCaptureSuggestion(null);
          setCaptureSuggestionError(tr("suggestionUnavailable"));
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
  }, [capture, captureType, draft, activeWorkspaceId, writeWorkspaceId, captureProjectId, items, language]);

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
      updatedAt: Date.now(),
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
    const now = Date.now();
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
    testNotification, saveNotificationSettings } = useNotifications({ tr });
  const calendarTimezone = notificationState?.preferences.timezone || "Europe/Prague";
  const calendarTodayParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: calendarTimezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(badgeNow)).map((part) => [part.type, part.value]));
  const calendarToday = `${calendarTodayParts.year}-${calendarTodayParts.month}-${calendarTodayParts.day}`;
  const dayPlanState = useDayPlan({ authState, activeWorkspaceId, writeWorkspaceId, items, language, tr, calendarToday,
    calendarWorkspaceSelection, askConfirm, closeDetail, pullFromServer, selectWorkspace, syncQueue, pendingKey });
  const { applyDayPlanAction, currentDayPlanBlock, dayPlanBusy, dayPlanStatus, dayPlanTimeline, dayPlanUndo, dayPlanWhy, loadDayPlan, nextDayPlanBlock, setDayPlanNow, setDayPlanStatus, undoDayPlanBlock, visibleDayPlan, workElapsedText, workOverrun, workSession, workSessionAction, workSessionBusy, workSessionStatus } = dayPlanState;
  const { passkeys, passkeyLabel, setPasskeyLabel, passkeyPassword, setPasskeyPassword, passkeyStatus, registerPasskey,
    removePasskey } = usePasskeys({ view, authState, tr, askConfirm, setPasskeyBusy });
  const { backups, setBackups, backupStatus, setBackupStatus, createServerBackup, restoreServerBackup } = useBackups({
    language, tr, askConfirm, applySnapshot, pendingKey, deletedKey, revivedKey });
  const attentionState = useAttention({ authState, activeWorkspaceId, syncStatus, items, pendingDeletedIds });
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
    const now = Date.now(),
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
    const workspace = await db.entities.get(
      `workspace:${creationWorkspaceId}`,
    );
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
    const relationTimestamp = Date.now();
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
  async function rename(e: Entity, title: string) {
    if (!title.trim()) return;
    const current = (await db.entities.get(e.id)) || e;
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
      updatedAt: Date.now(),
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    setSelected((await db.entities.get(e.id)) || null);
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
    const deletedIds = new Set(pendingDeletedIds());
    deletedIds.add(e.id);
    localStorage.setItem(deletedKey, JSON.stringify([...deletedIds]));
    setUndo(e);
    setUndoRelations(linkedRelations);
    await syncToServer();
    closeDetail();
    load();
  }
  async function setProjectStatus(project: Entity, status: "active" | "completed") {
    if (project.type !== "project") return;
    const current = (await db.entities.get(project.id)) || project;
    const timestamp = Date.now();
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
        updatedAt: Date.now(),
      });
      if (undoRelations.length) await db.relations.bulkPut(undoRelations);
    });
    localDataVersion.current += 1;
    const deletedIds = pendingDeletedIds().filter((id) => id !== undo.id);
    if (deletedIds.length)
      localStorage.setItem(deletedKey, JSON.stringify(deletedIds));
    else localStorage.removeItem(deletedKey);
    const revivedIds = new Set(pendingRevivedIds());
    revivedIds.add(undo.id);
    localStorage.setItem(revivedKey, JSON.stringify([...revivedIds]));
    await syncToServer();
    setUndo(null);
    setUndoRelations([]);
    load();
  }
  // `onlyIfOpen`: put the saved record into the detail panel only while that record is still the
  // one open there (a save that finishes after the panel was closed must not reopen it).
  async function patch(e: Entity, properties: Record<string, unknown>, action = "updated", onlyIfOpen = false) {
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
          ...properties,
          activity: [...activity, { at: Date.now(), action }].slice(-50),
        },
        updatedAt: Date.now(),
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
      updatedAt: Date.now(),
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
      updatedAt: Date.now(),
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
    const timestamp = Date.now();
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
    const timestamp = Date.now();
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
    claimBusyId,
    claimEvidence,
    claimFilterId,
    claimFreshness,
    claimHistory,
    claimPredicate,
    claimSensitivity,
    claimSourceLocator,
    claimSourceProvider,
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
    language,
    loadCalendar,
    login,
    logout,
    logoutBusy,
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
    setClaimEvidence,
    setClaimFilterId,
    setClaimFreshness,
    setClaimPredicate,
    setClaimSensitivity,
    setClaimSourceLocator,
    setClaimSourceProvider,
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
