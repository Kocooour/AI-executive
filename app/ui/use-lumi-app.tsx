"use client";
import { type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { db, ensureDefaultWorkspace, migratePropertyRelations, personalWorkspaceId, seed, type Entity, type EntityType, type Relation } from "../../lib/db";
import { clearLocalData, finishInterruptedWipe, hasUnsentChanges } from "../../lib/local-data";
import { runSignOut } from "../../lib/sign-out";
import { watchSession } from "../../lib/session-watch";
import { addressUpdate, viewFromSearch } from "../../lib/view-url";
import { buildContext, type ContextBundle } from "../../lib/context";
import { mergeSnapshots, type ServerSnapshot } from "../../lib/server-sync";
import { fetchClientAuthStatus } from "../../lib/client-auth-status";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { addLocalDays, fromLocalDateTime, toLocalDateTime, ymd, zonedDateTimeToIso } from "../../lib/local-dates";
import { byManualOrder, manualOrder, newTaskPlacement, parseCaptureText, taskMatchesView } from "../../lib/task-views";
import { findActiveProjectWithTitle } from "../../lib/project-title";
import { type AIProposal, type AssistantMessage, type AttentionResponse, type BackupSummary, type CalendarEvent, type CalendarSourceState, type CaptureProjectAction, type CaptureSuggestion, type ConfirmRequest, type ContextClaimItem, type ContextInboxProposal, type ContextInboxTaskDraft, type DayPlan, type DayPlanItem, type DurableContextItem, type Language, type NotificationPreferences, type NotificationState, type PACTAgentResult, type PACTAgentRunSummary, type PACTAgentSummary, type PasskeySummary, type StandaloneSubjectItem, type ThemeMode, type WorkSession } from "./types";
import { copy } from "./copy";
import { views } from "./navigation";
import { urlBase64ToUint8Array } from "./format";

// All client state, effects and handlers of the Lumi app shell, moved verbatim from app/page.tsx.
// Views receive the returned object as `app` and destructure what they render.
export function useLumiApp() {
  const [items, setItems] = useState<Entity[]>([]),
    [relations, setRelations] = useState<any[]>([]),
    [view, setView] = useState("Home"),
    [text, setText] = useState(""),
    [selected, setSelected] = useState<Entity | null>(null),
    [query, setQuery] = useState(""),
    [capture, setCapture] = useState(false),
    [captureType, setCaptureType] = useState<"task" | "note">("task"),
    [captureProjectId, setCaptureProjectId] = useState(""),
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
    [syncStatus, setSyncStatus] = useState<
      "connecting" | "synced" | "syncing" | "offline"
    >("connecting"),
    [backups, setBackups] = useState<BackupSummary[]>([]),
    [backupStatus, setBackupStatus] = useState(""),
    [standalone, setStandalone] = useState(false),
    [notificationState, setNotificationState] = useState<NotificationState | null>(null),
    [badgeNow, setBadgeNow] = useState(() => Date.now()),
    [dayPlanNow, setDayPlanNow] = useState(() => Date.now()),
    [badgeStatus, setBadgeStatus] = useState(""),
    [notificationStatus, setNotificationStatus] = useState(""),
    [dayPlan, setDayPlan] = useState<DayPlan | null>(null),
    [attention, setAttention] = useState<AttentionResponse | null>(null),
    [attentionError, setAttentionError] = useState(""),
    [authNotice, setAuthNotice] = useState(""),
    [attentionReload, setAttentionReload] = useState(0),
    [addressReady, setAddressReady] = useState(false),
    [deepLinkDone, setDeepLinkDone] = useState(false),
    [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null),
    [logoutBusy, setLogoutBusy] = useState(false),
    [logoutError, setLogoutError] = useState(""),
    [attentionOutdated, setAttentionOutdated] = useState(false),
    [attentionBusyKey, setAttentionBusyKey] = useState(""),
    [showAllAttention, setShowAllAttention] = useState(false),
    [dayPlanStatus, setDayPlanStatus] = useState(""),
    [dayPlanBusy, setDayPlanBusy] = useState(false),
    [dayPlanUndo, setDayPlanUndo] = useState<{ actionId: string; workspaceId: string; date: string } | null>(null),
    [workSession, setWorkSession] = useState<WorkSession | null>(null),
    [workSessionBusy, setWorkSessionBusy] = useState(false),
    [workSessionStatus, setWorkSessionStatus] = useState(""),
    [workSessionNow, setWorkSessionNow] = useState(() => Date.now()),
    [workSessionLoadedAt, setWorkSessionLoadedAt] = useState(() => Date.now()),
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
    [authState, setAuthState] = useState<
      "checking" | "ready" | "required" | "misconfigured" | "unavailable"
    >("checking"),
    [authEnabled, setAuthEnabled] = useState(false),
    [authPassword, setAuthPassword] = useState(""),
    [authError, setAuthError] = useState(""),
    [passkeySupported, setPasskeySupported] = useState(false),
    [passkeyBusy, setPasskeyBusy] = useState(false),
    [passkeys, setPasskeys] = useState<PasskeySummary[]>([]),
    [passkeyLabel, setPasskeyLabel] = useState("My passkey"),
    [passkeyPassword, setPasskeyPassword] = useState(""),
    [passkeyStatus, setPasskeyStatus] = useState(""),
    [aiText, setAiText] = useState(""),
    [aiBusy, setAiBusy] = useState(false),
    [messages, setMessages] = useState<AssistantMessage[]>([]);
  const serverRevision = useRef(0);
  const tr = (key: string) => copy[language][key] || key;
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
  const dayPlanWhy = (reason: string) => {
    if (reason.startsWith("duration:")) return language === "cs" ? `Odhad trvání je ${reason.slice(9)} minut.` : `Estimated duration is ${reason.slice(9)} minutes.`;
    const labels: Record<string, [string, string]> = {
      already_planned: ["Úkol už je v kalendáři.", "The task is already in the calendar."],
      overdue: ["Úkol je po termínu.", "The task is overdue."], due_today: ["Úkol má termín dnes.", "The task is due today."],
      deadline_close: ["Termín se blíží.", "The deadline is close."], high_priority: ["Úkol má vysokou prioritu.", "The task has high priority."],
      context_importance: ["Potvrzený kontext označuje úkol nebo projekt jako důležitý.", "Confirmed context marks the task or project as important."],
      context_waiting: ["Podle potvrzeného kontextu někdo čeká na výsledek.", "Confirmed context says someone is waiting for the result."],
      calendar_free: ["V kalendáři je vhodné volné okno.", "A suitable free calendar window is available."],
    };
    return labels[reason]?.[language === "cs" ? 0 : 1] || reason;
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
  const draggingIdRef = useRef("");
  const dragScopeRef = useRef("");
  const dragTargetRef = useRef("");
  const pointerDragRef = useRef({ id: "", startX: 0, startY: 0, active: false });
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const notificationSettingsQueue = useRef<Promise<void>>(Promise.resolve());
  const localDataVersion = useRef(0);
  const calendarLoadVersion = useRef(0);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const moreDialogRef = useRef<HTMLDivElement>(null);
  const contextClaimLoadVersion = useRef(0);
  const dayPlanLoadVersion = useRef(0);
  const attentionLoadVersion = useRef(0);
  const workSessionLoadVersion = useRef(0);
  const calendarWorkspaceSelection = useRef("personal");
  calendarWorkspaceSelection.current = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
  // One confirmation at a time: asking again answers the previous question with "no".
  const confirmResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const authStateRef = useRef("checking");
  authStateRef.current = authState;
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
  const signedOut = useRef(false);
  const pendingKey = "ai-executive-pending-sync";
  const deletedKey = "ai-executive-pending-deletions";
  const revivedKey = "ai-executive-pending-revivals";
  const pendingDeletedIds = () => {
    try {
      return JSON.parse(localStorage.getItem(deletedKey) || "[]") as string[];
    } catch {
      return [];
    }
  };
  const pendingRevivedIds = () => {
    try {
      return JSON.parse(localStorage.getItem(revivedKey) || "[]") as string[];
    } catch {
      return [];
    }
  };
  async function load() {
    setItems(await db.entities.toArray());
    setRelations(await db.relations.toArray());
  }
  async function applySnapshot(snapshot: ServerSnapshot, expectedVersion?: number) {
    if (signedOut.current) return false;
    if (expectedVersion !== undefined && localDataVersion.current !== expectedVersion) return false;
    await db.transaction("rw", db.entities, db.relations, async () => {
      if (signedOut.current) throw new Error("LOCAL_DATA_CHANGED");
      if (expectedVersion !== undefined && localDataVersion.current !== expectedVersion) {
        throw new Error("LOCAL_DATA_CHANGED");
      }
      await db.entities.clear();
      await db.relations.clear();
      if (snapshot.entities.length) await db.entities.bulkAdd(snapshot.entities);
      if (snapshot.relations.length)
        await db.relations.bulkAdd(snapshot.relations);
    });
    serverRevision.current = snapshot.revision;
    await load();
    return true;
  }
  async function putSnapshot(
    entities: Entity[],
    snapshotRelations: any[],
    baseRevision: number,
    deletedIds: string[] = [],
    revivedIds: string[] = [],
  ) {
    return fetch("/api/store", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision,
        entities,
        relations: snapshotRelations,
        deletedIds,
        revivedIds,
      }),
    });
  }
  // Saves that were asked for and have not started yet.
  const queuedSaves = useRef(0);
  // After a save that could not settle, one more is needed. A change that is being written or
  // already has its own save queued brings it anyway; only otherwise is one added here.
  function settleLater() {
    if (queuedSaves.current > 0 || localDataVersion.current % 2 === 1 || signedOut.current) return;
    void syncToServer();
  }
  async function syncToServer() {
    queuedSaves.current += 1;
    const operation = syncQueue.current.then(async () => {
      queuedSaves.current -= 1;
      setSyncStatus("syncing");
      localStorage.setItem(pendingKey, "1");
      const localVersion = localDataVersion.current;
      const localEntities = await db.entities.toArray();
      const localRelations = await db.relations.toArray();
      let response = await putSnapshot(
        localEntities,
        localRelations,
        serverRevision.current,
        pendingDeletedIds(),
        pendingRevivedIds(),
      );
      let mergedWithServer = false;
      // The server may change again between the conflict and the merged save; try a few times
      // before giving up until the next trigger.
      for (let attempt = 0; attempt < 3 && response.status === 409; attempt += 1) {
        mergedWithServer = true;
        const current = (await response.json()) as ServerSnapshot;
        const deletedIds = new Set(pendingDeletedIds());
        const revivedIds = new Set(pendingRevivedIds());
        const filteredCurrent = {
          ...current,
          tombstones: (current.tombstones || []).filter((item) => !revivedIds.has(item.id)),
          entities: current.entities.filter((entity) => !deletedIds.has(entity.id)),
          relations: current.relations.filter(
            (relation) =>
              !deletedIds.has(relation.sourceEntityId) &&
              !deletedIds.has(relation.targetEntityId),
          ),
        };
        const merged = mergeSnapshots(
          filteredCurrent,
          localEntities,
          localRelations,
        );
        response = await putSnapshot(
          merged.entities,
          merged.relations,
          current.revision,
          pendingDeletedIds(),
          pendingRevivedIds(),
        );
      }
      if (!response.ok) throw new Error("Server synchronization failed");
      const saved = (await response.json()) as ServerSnapshot;
      let applied = false;
      try {
        applied = await applySnapshot(saved, localVersion);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "LOCAL_DATA_CHANGED") throw error;
      }
      if (!applied) {
        // The local copy changed during the save, so the saved state was not taken over. The
        // known revision may advance only when the server holds exactly what was sent. After a
        // merge it also holds records this device does not have; claiming its revision would
        // make the next save replace them. Keeping the old revision makes that save merge again.
        if (!mergedWithServer) serverRevision.current = saved.revision;
        settleLater();
        return;
      }
      // Something was changed while the saved state was being loaded. That change has its own
      // save queued, which still needs the lists of deleted and restored records.
      if (localDataVersion.current !== localVersion) {
        settleLater();
        return;
      }
      localStorage.setItem("ai-executive-server-synced", "1");
      localStorage.removeItem(pendingKey);
      localStorage.removeItem(deletedKey);
      localStorage.removeItem(revivedKey);
      setSyncStatus("synced");
    });
    syncQueue.current = operation.catch(() => {
      setSyncStatus("offline");
    });
    return syncQueue.current;
  }
  async function pullFromServer() {
    await syncQueue.current;
    if (localStorage.getItem(pendingKey) === "1") {
      await syncToServer();
      return;
    }
    try {
      const pullVersion = localDataVersion.current;
      const response = await fetch("/api/store", { cache: "no-store" });
      if (!response.ok) throw new Error("Server synchronization failed");
      const snapshot = (await response.json()) as ServerSnapshot;
      await syncQueue.current;
      if (localStorage.getItem(pendingKey) === "1") {
        await syncToServer();
        return;
      }
      if (snapshot.revision > serverRevision.current) {
        try {
          await applySnapshot(snapshot, pullVersion);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "LOCAL_DATA_CHANGED") throw error;
        }
      }
      setSyncStatus("synced");
    } catch {
      setSyncStatus("offline");
    }
  }
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
  const authCheckVersion = useRef(0);
  // The session lasts a limited time. When the server starts refusing data requests the app
  // returns to the sign-in screen and says why; nothing local is removed, so changes that were
  // not sent yet go out after signing in again.
  const contextScopeLoaded = useRef("");
  const sessionEndCheck = useRef(false);
  const sessionEndedHere = useRef(false);
  const sessionEndHandler = useRef(() => {});
  sessionEndHandler.current = () => {
    if (authStateRef.current !== "ready" || signedOut.current || sessionEndCheck.current) return;
    sessionEndCheck.current = true;
    // One refused request is not proof: it may be an answer to a request sent before a fresh
    // sign-in. The server is asked directly, and only its "not signed in" ends the session here.
    fetchClientAuthStatus().then((state) => {
      if (state.authenticated || authStateRef.current !== "ready" || signedOut.current) return;
      // Leaving a field commits what was typed in it; the shell is about to be taken off the screen.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      answerConfirm(false);
      setAuthPassword("");
      setAuthError("");
      setAuthNotice(tr("sessionEnded"));
      sessionEndedHere.current = true;
      setAuthState("required");
    }).catch(() => undefined).finally(() => { sessionEndCheck.current = false; });
  };
  useEffect(() => {
    const original = window.fetch;
    const watched = watchSession(original.bind(window), window.location.origin, () => sessionEndHandler.current());
    window.fetch = watched as typeof window.fetch;
    return () => { if (window.fetch === watched) window.fetch = original; };
  }, []);
  useEffect(() => { if (authState === "ready") { setAuthNotice(""); sessionEndedHere.current = false; } }, [authState]);
  async function checkAccess() {
    const version = ++authCheckVersion.current;
    setAuthError("");
    setAuthState("checking");
    try {
      const state = await fetchClientAuthStatus();
      if (version !== authCheckVersion.current) return;
      setAuthEnabled(state.enabled);
      if (state.enabled && !state.configured) {
        setAuthError("Authentication must be configured on the server before this app can be used.");
        setAuthState("misconfigured");
        return;
      }
      setAuthState(state.authenticated ? "ready" : "required");
    } catch {
      if (version !== authCheckVersion.current) return;
      setAuthState("unavailable");
    }
  }
  useEffect(() => {
    try { setPasskeySupported(browserSupportsWebAuthn()); } catch { setPasskeySupported(false); }
    void checkAccess();
    return () => { authCheckVersion.current += 1; };
  // The first access check runs once; retries are initiated by the user.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAgents(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const response = await fetch(`/api/executive?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Agents are unavailable");
    const data = await response.json();
    setPactAgents(Array.isArray(data.agents) ? data.agents : []);
    setAgentRuns(Array.isArray(data.agentRuns) ? data.agentRuns : []);
  }

  async function loadDayPlan(workspaceId: string, date: string) {
    const version = ++dayPlanLoadVersion.current;
    const response = await fetch(`/api/day-plan?workspaceId=${encodeURIComponent(workspaceId)}&date=${date}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Day plan unavailable");
    if (version === dayPlanLoadVersion.current && calendarWorkspaceSelection.current === workspaceId) setDayPlan(data as DayPlan);
    return data as DayPlan;
  }

  async function loadAttention(workspaceId: string) {
    const version = ++attentionLoadVersion.current;
    const current = () => version === attentionLoadVersion.current;
    let response: Response;
    try {
      response = await fetch(`/api/attention?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    } catch {
      // No connection: the out-of-date label says it, so there is no separate error text.
      if (current()) setAttentionOutdated(true);
      throw new Error("");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (current()) setAttentionOutdated(true);
      throw new Error(data.error || "Attention is unavailable");
    }
    if (current()) {
      setAttention(data as AttentionResponse);
      setAttentionOutdated(false);
      setAttentionError("");
    }
  }

  async function actOnAttention(item: AttentionResponse["items"][number], action: "snooze" | "dismiss") {
    if (!attention || attentionActionsBlocked) return;
    setAttentionBusyKey(item.attentionKey);
    setAttentionError("");
    try {
      const response = await fetch("/api/attention", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: item.workspaceId, attentionKey: item.attentionKey, sourceFingerprint: item.sourceFingerprint,
          expectedDataRevision: attention.dataRevision, action, ...(action === "snooze" ? { snoozeUntil: Date.now() + 24 * 3_600_000 } : {}) }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Attention action failed");
      await loadAttention(activeWorkspaceId);
    } catch (error) {
      await loadAttention(activeWorkspaceId).catch(() => undefined);
      setAttentionError(error instanceof Error ? error.message : "Attention action failed");
    } finally {
      setAttentionBusyKey("");
    }
  }

  async function loadWorkSession(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const version = ++workSessionLoadVersion.current;
    const response = await fetch(`/api/work-sessions?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Work session unavailable");
    if (version !== workSessionLoadVersion.current) return data.active as WorkSession | null;
    setWorkSession(data.active || null);
    const loadedAt = Date.now(); setWorkSessionLoadedAt(loadedAt); setWorkSessionNow(loadedAt);
    return data.active as WorkSession | null;
  }

  async function workSessionAction(action: "start" | "pause" | "resume" | "finish", task?: Entity) {
    if (workSessionBusy) return;
    const workspaceId = action === "start" && task ? task.workspaceId
      : workSession?.workspaceId || (activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId);
    if (action === "start" && task && activeWorkspaceId === "all" && task.workspaceId !== writeWorkspaceId) {
      calendarWorkspaceSelection.current = task.workspaceId;
      selectWorkspace(task.workspaceId);
    }
    workSessionLoadVersion.current += 1;
    if (action === "finish" && !(await askConfirm({ title: tr("workFinishTitle"), message: tr("workFinishFinal"), confirmLabel: tr("workFinish") }))) return;
    setWorkSessionBusy(true); setWorkSessionStatus("");
    try {
      const current = workSession;
      const response = await fetch("/api/work-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        action, workspaceId, idempotencyKey: crypto.randomUUID(), taskId: task?.id,
        expectedTaskUpdatedAt: task?.updatedAt, expectedRevision: current?.revision || 0, expectedState: current?.state || "idle",
      }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409) { await loadWorkSession(calendarWorkspaceSelection.current).catch(() => undefined); throw new Error(tr("workConflict")); }
        throw new Error(data.error || "Work session failed");
      }
      workSessionLoadVersion.current += 1;
      if (calendarWorkspaceSelection.current !== workspaceId) {
        if (data.taskCompleted) await pullFromServer();
        await loadWorkSession(calendarWorkspaceSelection.current).catch(() => undefined);
        return;
      }
      setWorkSession(data.session?.state === "completed" ? null : data.session);
      const loadedAt = Date.now(); setWorkSessionLoadedAt(loadedAt); setWorkSessionNow(loadedAt);
      if (data.taskCompleted) { closeDetail(); await pullFromServer(); await loadDayPlan(workspaceId, calendarToday).catch(() => undefined); }
    } catch (error) { setWorkSessionStatus(error instanceof Error ? error.message : "Work session failed"); }
    finally { setWorkSessionBusy(false); }
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
    if (view !== "Settings" || authState !== "ready") return;
    loadPasskeys().catch(() => setPasskeyStatus("Passkeys could not be loaded."));
  }, [view, authState]);

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

  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (!window.isSecureContext) {
      setAuthError("Open the HTTPS address before signing in.");
      return;
    }
    setAuthError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: authPassword }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setAuthError(body.error || "Sign-in failed.");
        return;
      }
      setAuthPassword("");
      setAuthState("ready");
      // Whatever this page believed about the server before signing in is not to be trusted
      // (the local copy may have been cleared by a sign-out in another tab).
      serverRevision.current = 0;
      await pullFromServer();
    } catch {
      setAuthError("The server could not be reached. Check your secure connection and try again.");
    }
  }

  async function signInWithPasskey() {
    setPasskeyBusy(true);
    setAuthError("");
    try {
      const optionsResponse = await fetch("/api/auth/passkeys/login/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const options = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(options.error || "Passkey sign-in is unavailable.");
      const credential = await startAuthentication({ optionsJSON: options });
      const verifyResponse = await fetch("/api/auth/passkeys/login/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: options.challenge, response: credential }),
      });
      const result = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(result.error || "Passkey sign-in failed.");
      setAuthState("ready");
      // Whatever this page believed about the server before signing in is not to be trusted
      // (the local copy may have been cleared by a sign-out in another tab).
      serverRevision.current = 0;
      await pullFromServer();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Passkey sign-in failed.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function loadPasskeys() {
    const response = await fetch("/api/auth/passkeys", { cache: "no-store" });
    if (!response.ok) throw new Error("Passkeys could not be loaded.");
    const body = await response.json();
    setPasskeys(body.passkeys || []);
  }

  async function registerPasskey() {
    setPasskeyBusy(true);
    setPasskeyStatus("");
    try {
      const optionsResponse = await fetch("/api/auth/passkeys/register/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: passkeyPassword }),
      });
      const options = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(options.error || "Passkey registration is unavailable.");
      const credential = await startRegistration({ optionsJSON: options });
      const verifyResponse = await fetch("/api/auth/passkeys/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challenge: options.challenge,
          response: credential,
          label: passkeyLabel.trim() || "Passkey",
        }),
      });
      const result = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(result.error || "Passkey registration failed.");
      await loadPasskeys();
      setPasskeyPassword("");
      setPasskeyStatus("Passkey added. You can now use Face ID or Touch ID to sign in.");
    } catch (error) {
      setPasskeyStatus(error instanceof Error ? error.message : "Passkey registration failed.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function removePasskey(id: string) {
    if (!(await askConfirm({ title: tr("passkeyRemoveTitle"), message: tr("passkeyRemoveConfirm"), confirmLabel: tr("remove"), danger: true }))) return;
    const response = await fetch("/api/auth/passkeys", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setPasskeyStatus(body.error || "Passkey could not be removed.");
      return;
    }
    await loadPasskeys();
    setPasskeyStatus("Passkey removed.");
  }

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
        sync: syncToServer,
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

  useEffect(() => {
    fetch("/api/notifications", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((state) => setNotificationState(state as NotificationState))
      .catch(() => undefined);
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
      .catch(() => setBackupStatus("Server settings are unavailable while offline."));
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
      setWorkspaceDraft(workspace.title);
    }
  }, [activeWorkspaceId, items, writeWorkspaceId]);

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
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
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
  async function enableNotifications() {
    setNotificationStatus("Requesting permission…");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("Push notifications are not supported in this browser.");
      }
      if (!window.isSecureContext) {
        throw new Error("Open the HTTPS address to enable notifications.");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted.");
      const stateResponse = await fetch("/api/notifications", { cache: "no-store" });
      if (!stateResponse.ok) throw new Error("Notification service is unavailable.");
      const state = (await stateResponse.json()) as NotificationState;
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(state.publicKey),
        });
      }
      const response = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "subscribe", subscription: subscription.toJSON() }),
      });
      if (!response.ok) throw new Error("The device could not be registered.");
      setNotificationState((await response.json()) as NotificationState);
      setNotificationStatus("Notifications enabled on this device.");
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : "Notifications could not be enabled.");
    }
  }
  async function disableNotifications() {
    setNotificationStatus("Disabling notifications…");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "unsubscribe", endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      const state = await fetch("/api/notifications", { cache: "no-store" }).then((response) => response.json());
      setNotificationState(state as NotificationState);
      setNotificationStatus("Notifications disabled on this device.");
    } catch {
      setNotificationStatus("Notifications could not be disabled.");
    }
  }
  async function testNotification() {
    setNotificationStatus("Sending test notification…");
    try {
      const response = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The test could not be sent.");
      if (result.sent) {
        setNotificationStatus(
          result.failed
            ? `Test sent to ${result.sent} device(s); ${result.failed} delivery failed.`
            : `Test sent to ${result.sent} device(s).`,
        );
      } else if (result.total) {
        setNotificationStatus(`Delivery failed for all ${result.total} registered device(s).`);
      } else {
        setNotificationStatus("No device is registered for notifications.");
      }
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : "The test could not be sent.");
    }
  }
  async function saveNotificationSettings(preferences: NotificationPreferences) {
    setNotificationState((current) => current ? { ...current, preferences } : current);
    notificationSettingsQueue.current = notificationSettingsQueue.current
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch("/api/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "preferences", preferences }),
        });
        if (!response.ok) throw new Error();
        setNotificationStatus("Reminder settings saved.");
      })
      .catch(() => setNotificationStatus("Reminder settings could not be saved."));
    await notificationSettingsQueue.current;
  }
  async function createServerBackup() {
    setBackupStatus("Creating backup…");
    try {
      const response = await fetch("/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      if (!response.ok) throw new Error("Backup failed");
      const listResponse = await fetch("/api/backups", { cache: "no-store" });
      const data = await listResponse.json();
      setBackups(data.backups || []);
      setBackupStatus("Backup created.");
    } catch {
      setBackupStatus("Backup failed. Check the server connection.");
    }
  }
  async function restoreServerBackup(backup: BackupSummary) {
    if (!(await askConfirm({ title: tr("backupRestoreTitle"), confirmLabel: tr("restore"), danger: true,
      message: tr("backupRestoreConfirm").replace("{date}", () => new Date(backup.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")) }))) return;
    setBackupStatus("Restoring backup…");
    try {
      const response = await fetch("/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore", name: backup.name }),
      });
      if (!response.ok) throw new Error("Restore failed");
      const data = await response.json();
      await applySnapshot(data.snapshot as ServerSnapshot);
      localStorage.removeItem(pendingKey);
      localStorage.removeItem(deletedKey);
      localStorage.removeItem(revivedKey);
      setBackupStatus("Backup restored.");
      const listResponse = await fetch("/api/backups", { cache: "no-store" });
      const list = await listResponse.json();
      setBackups(list.backups || []);
    } catch {
      setBackupStatus("Restore failed. Current data was not changed.");
    }
  }
  const workspaces = items
      .filter((entity) => entity.type === "workspace")
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
        : activeWorkspace?.title || "Personal",
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
  const calendarTimezone = notificationState?.preferences.timezone || "Europe/Prague";
  const calendarTodayParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: calendarTimezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(badgeNow)).map((part) => [part.type, part.value]));
  const calendarToday = `${calendarTodayParts.year}-${calendarTodayParts.month}-${calendarTodayParts.day}`;
  const visibleDayPlan = dayPlan?.workspaceId === (activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) && dayPlan.date === calendarToday ? dayPlan : null;
  const shownAttention = attention?.workspaceId === activeWorkspaceId ? attention : null;
  const attentionStale = Boolean(shownAttention) && attentionOutdated;
  // Snooze and dismiss need the server to hold the same data as this device.
  const attentionActionsBlocked = attentionOutdated || syncStatus !== "synced";
  // Until the server evaluates again, hide what was finished or deleted on this device meanwhile.
  const visibleAttention = (() => {
    if (!shownAttention || !attentionActionsBlocked) return shownAttention;
    const deleted = new Set(pendingDeletedIds());
    return { ...shownAttention, items: shownAttention.items.filter((candidate) => {
      if (deleted.has(candidate.subjectId)) return false;
      const local = items.find((item) => item.id === candidate.subjectId && item.workspaceId === candidate.workspaceId);
      return local?.status !== "completed";
    }) };
  })();
  const dayPlanTimeline = visibleDayPlan ? [...visibleDayPlan.existingBlocks.map((item) => ({ ...item, existing: true })),
    ...visibleDayPlan.planBlocks.map((item) => ({ ...item, existing: false }))].sort((a, b) => String(a.start).localeCompare(String(b.start))) : [];
  const currentDayPlanBlock = dayPlanTimeline.find((item) => Date.parse(item.start || "") <= dayPlanNow && dayPlanNow < Date.parse(item.end || ""));
  const nextDayPlanBlock = dayPlanTimeline.find((item) => Date.parse(item.start || "") > dayPlanNow);
  const workElapsedMs = workSession ? workSession.elapsedMs + (workSession.state === "running" ? Math.max(0, workSessionNow - workSessionLoadedAt) : 0) : 0;
  const workElapsedText = `${String(Math.floor(workElapsedMs / 3_600_000)).padStart(2, "0")}:${String(Math.floor(workElapsedMs / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(workElapsedMs / 1000) % 60).padStart(2, "0")}`;
  const workOverrun = Boolean(workSession?.estimatedMinutes && workElapsedMs > workSession.estimatedMinutes * 60_000);
  const calendarTomorrowDate = new Date(`${calendarToday}T12:00:00Z`);
  calendarTomorrowDate.setUTCDate(calendarTomorrowDate.getUTCDate() + 1);
  const calendarTomorrow = calendarTomorrowDate.toISOString().slice(0, 10);
  useEffect(() => {
    if (authState !== "ready") return;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setDayPlan(null);
    setDayPlanStatus("");
    loadDayPlan(workspaceId, calendarToday)
      .catch(() => { if (calendarWorkspaceSelection.current === workspaceId) setDayPlanStatus(language === "cs" ? "Plán dne se nepodařilo načíst." : "The day plan is unavailable."); });
  }, [authState, activeWorkspaceId, writeWorkspaceId, calendarToday, items]);
  // The last evaluation survives a lost connection so Home can show it as stale; it is dropped only
  // when the workspace or the session changes.
  useEffect(() => {
    attentionLoadVersion.current += 1;
    setAttention(null);
    setAttentionOutdated(false);
    setAttentionError("");
    setShowAllAttention(false);
  }, [authState, activeWorkspaceId]);
  // Out of date from the moment the connection is lost until a load succeeds again, so the label
  // does not flip while a queued edit retries its sync.
  useEffect(() => {
    if (syncStatus === "offline") setAttentionOutdated(true);
  }, [syncStatus]);
  useEffect(() => {
    const lost = () => setAttentionOutdated(true);
    // The sync state may never have left "synced" during a short drop, so coming back online
    // has to ask for a fresh evaluation itself instead of waiting for the next periodic one.
    const back = () => setAttentionReload((count) => count + 1);
    window.addEventListener("offline", lost);
    window.addEventListener("online", back);
    return () => { window.removeEventListener("offline", lost); window.removeEventListener("online", back); };
  }, []);
  useEffect(() => {
    if (authState !== "ready" || syncStatus !== "synced") return;
    const workspaceId = activeWorkspaceId;
    let cancelled = false;
    const refresh = () => loadAttention(workspaceId).catch((error) => { if (!cancelled) setAttentionError(error instanceof Error ? error.message : "Attention is unavailable"); });
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    return () => { cancelled = true; attentionLoadVersion.current += 1; window.clearInterval(timer); };
  }, [authState, activeWorkspaceId, syncStatus, attentionReload]);
  useEffect(() => {
    if (authState !== "ready") return;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      setDayPlanNow(Date.now());
      loadDayPlan(calendarWorkspaceSelection.current, calendarToday).catch(() => undefined);
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [authState, calendarToday]);
  useEffect(() => {
    if (authState !== "ready") return;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    loadWorkSession(workspaceId).catch((error) => setWorkSessionStatus(error instanceof Error ? error.message : "Work session unavailable"));
    const refresh = () => { if (document.visibilityState === "visible") loadWorkSession(workspaceId).catch(() => undefined); };
    const poll = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { workSessionLoadVersion.current += 1; window.clearInterval(poll); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [authState, activeWorkspaceId, writeWorkspaceId]);
  useEffect(() => {
    if (workSession?.state !== "running") return;
    const timer = window.setInterval(() => setWorkSessionNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [workSession?.id, workSession?.state]);
  const attentionTaskCount = items.filter((task) => {
    if (task.type !== "task" || task.status !== "open") return false;
    return [task.properties.when, task.properties.deadline].some(
      (due) => typeof due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(due) && due <= calendarTomorrow,
    );
  }).length;
  useEffect(() => {
    if (authState !== "ready" || !notificationState) return;
    const nextMidnight = Date.parse(zonedDateTimeToIso(calendarTomorrow, "00:00", calendarTimezone));
    const timer = window.setTimeout(() => setBadgeNow(Date.now()), Math.max(1000, nextMidnight - Date.now() + 1000));
    const refresh = () => {
      if (document.visibilityState === "visible") setBadgeNow(Date.now());
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [authState, notificationState, calendarTomorrow, calendarTimezone]);
  useEffect(() => {
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (typeof badgeNavigator.setAppBadge !== "function") return;
    if (authState === "ready" && !notificationState) return;
    const update = authState === "ready" && attentionTaskCount > 0
      ? badgeNavigator.setAppBadge(attentionTaskCount)
      : typeof badgeNavigator.clearAppBadge === "function"
        ? badgeNavigator.clearAppBadge()
        : badgeNavigator.setAppBadge(0);
    update.catch(() => undefined);
  }, [attentionTaskCount, authState, notificationState]);
  async function testAppBadge() {
    setBadgeStatus(tr("badgeTesting"));
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
    };
    if (!standalone) {
      setBadgeStatus(tr("badgeInstallRequired"));
      return;
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      setBadgeStatus(tr("badgePermissionRequired"));
      return;
    }
    if (typeof badgeNavigator.setAppBadge !== "function") {
      setBadgeStatus(tr("badgeUnavailable"));
      return;
    }
    try {
      await badgeNavigator.setAppBadge(1);
      setBadgeStatus(tr("badgeTestReady"));
    } catch (error) {
      console.warn("App badge test failed", error);
      setBadgeStatus(tr("badgeFailed"));
    }
  }
  async function restoreAppBadge() {
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (typeof badgeNavigator.setAppBadge !== "function") {
      setBadgeStatus(tr("badgeUnavailable"));
      return;
    }
    try {
      if (attentionTaskCount > 0) await badgeNavigator.setAppBadge(attentionTaskCount);
      else if (typeof badgeNavigator.clearAppBadge === "function") await badgeNavigator.clearAppBadge();
      else await badgeNavigator.setAppBadge(0);
      setBadgeStatus(tr("badgeRestored"));
    } catch (error) {
      console.warn("App badge restore failed", error);
      setBadgeStatus(tr("badgeFailed"));
    }
  }
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
    const suggestedAreaId = suggestion?.areaId || "";
    const suggestedDate = parsed.when || suggestion?.scheduledDate || "";
    const globalTask = captureType === "task" && !captureProjectId;
    setCapture(false);
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
        const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
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
  async function patch(e: Entity, properties: Record<string, unknown>, action = "updated") {
    const current = (await db.entities.get(e.id)) || e;
    const activity = Array.isArray(current.properties.activity)
      ? current.properties.activity
      : [];
    localDataVersion.current += 1;
    await db.entities.update(e.id, {
      properties: {
        ...current.properties,
        ...properties,
        activity: [...activity, { at: Date.now(), action }].slice(-50),
      },
      updatedAt: Date.now(),
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    setSelected((await db.entities.get(e.id)) || null);
  }
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
  async function applyDayPlanAction(item: DayPlanItem, decision: "accepted" | "tomorrow" | "dismissed") {
    if (dayPlanBusy || !dayPlan) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dayPlan.workspaceId !== calendarWorkspaceSelection.current || dayPlan.date !== calendarToday) return;
    const task = items.find((candidate) => candidate.id === item.taskId && candidate.type === "task" && candidate.status === "open" && candidate.workspaceId === dayPlan.workspaceId);
    if (!task) { setDayPlanStatus(tr("dayPlanChanged")); return; }
    setDayPlanBusy(true);
    setDayPlanStatus("");
    try {
      await syncQueue.current;
      if (localStorage.getItem(pendingKey) === "1") throw new Error(tr("dayPlanSyncFirst"));
      const current = await loadDayPlan(dayPlan.workspaceId, dayPlan.date);
      if (calendarWorkspaceSelection.current !== dayPlan.workspaceId || calendarToday !== dayPlan.date) throw new Error(tr("dayPlanChanged"));
      const stillProposed = current.planBlocks.find((block) => block.taskId === item.taskId && block.start === item.start && block.end === item.end);
      const stillUnscheduled = current.unscheduled.some((candidate) => candidate.taskId === item.taskId);
      if (!stillProposed && !stillUnscheduled) throw new Error(tr("dayPlanChanged"));
      if (decision === "accepted" && (!stillProposed || !item.start || !item.end)) throw new Error(tr("dayPlanChanged"));
      const proposeResponse = await fetch("/api/day-plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: current.workspaceId, date: current.date, revision: current.revision,
        taskId: item.taskId, start: item.start || "", end: item.end || "", decision }) });
      const proposed = await proposeResponse.json().catch(() => ({}));
      if (!proposeResponse.ok) throw new Error(proposed.error || tr("dayPlanChanged"));
      const proposal = proposed.proposal as AIProposal;
      const actionLabel = tr(decision === "accepted" ? "acceptBlock" : decision === "tomorrow" ? "moveTomorrow" : "skipPlanning");
      const planTitle = task.title.replace(/\s+/g, " ").slice(0, 160);
      const planKey = decision === "accepted" ? "dayPlanAccept" : decision === "tomorrow" ? "dayPlanTomorrow" : "dayPlanSkip";
      if (!(await askConfirm({ title: tr(`${planKey}Title`), confirmLabel: actionLabel, returnFocus: trigger,
        message: tr(`${planKey}Confirm`).replace("{title}", () => planTitle).replace("{time}", () => `${item.start} – ${item.end}`) }))) {
        await fetch("/api/ai/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", proposalId: proposal.id }) });
        return;
      }
      if (calendarWorkspaceSelection.current !== dayPlan.workspaceId || calendarToday !== dayPlan.date) throw new Error(tr("dayPlanChanged"));
      const confirmResponse = await fetch("/api/ai/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "confirm", proposalId: proposal.id }) });
      const confirmed = await confirmResponse.json().catch(() => ({}));
      if (!confirmResponse.ok) throw new Error(confirmed.error || tr("dayPlanChanged"));
      setDayPlanUndo({ actionId: confirmed.actionId, workspaceId: current.workspaceId, date: current.date });
      await pullFromServer();
      await loadDayPlan(current.workspaceId, current.date);
    } catch (error) {
      setDayPlanStatus(error instanceof Error ? error.message : tr("dayPlanChanged"));
    } finally {
      setDayPlanBusy(false);
    }
  }
  async function undoDayPlanBlock() {
    if (!dayPlanUndo || dayPlanBusy) return;
    setDayPlanBusy(true);
    try {
      const response = await fetch("/api/ai/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "undo", actionId: dayPlanUndo.actionId }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || tr("dayPlanChanged"));
      setDayPlanUndo(null);
      await pullFromServer();
      await loadDayPlan(dayPlanUndo.workspaceId, dayPlanUndo.date);
    } catch (error) { setDayPlanStatus(error instanceof Error ? error.message : tr("dayPlanChanged")); }
    finally { setDayPlanBusy(false); }
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
    acceptNativeDrop,
    actOnAttention,
    activeWorkspace,
    activeWorkspaceId,
    agentBusyId,
    agentResult,
    agentRuns,
    agentStatus,
    aiBusy,
    aiText,
    applyDayPlanAction,
    approveContextInbox,
    areas,
    askAI,
    assistantOpen,
    attentionBusyKey,
    attentionActionsBlocked,
    attentionError,
    attentionOutdated,
    attentionStale,
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
    currentDayPlanBlock,
    dayPlanBusy,
    dayPlanStatus,
    dayPlanTimeline,
    dayPlanUndo,
    dayPlanWhy,
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
    enableNotifications,
    freeHours,
    freeWindows,
    homeGreeting,
    homeTodayTasks,
    inspect,
    items,
    language,
    loadAttention,
    loadCalendar,
    loadDayPlan,
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
    nextDayPlanBlock,
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
    saveNotificationSettings,
    saveTheme,
    saveWorkspaceName,
    scheduleTask,
    scopedItems,
    scopedRelations,
    selectWorkspace,
    selectWriteWorkspace,
    selected,
    setActiveDragTarget,
    setAiText,
    setAssistantOpen,
    setAttentionError,
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
    setDayPlanNow,
    setDayPlanStatus,
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
    setShowAllAttention,
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
    showAllAttention,
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
    undoDayPlanBlock,
    useCaptureSuggestion,
    view,
    visibleAttention,
    visibleDayPlan,
    workElapsedText,
    workOverrun,
    workSession,
    workSessionAction,
    workSessionBusy,
    workSessionStatus,
    workspaceDraft,
    workspaceMenuOpen,
    workspaceName,
    workspaces,
    writeWorkspace,
    writeWorkspaceId,
  };
}

export type LumiApp = ReturnType<typeof useLumiApp>;
