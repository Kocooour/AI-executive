"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  db,
  ensureDefaultWorkspace,
  personalWorkspaceId,
  seed,
  migratePropertyRelations,
  type Entity,
  type EntityType,
} from "../lib/db";
import { buildContext, type ContextBundle } from "../lib/context";
import type { AIMessage } from "../lib/ai-provider";
import { mergeSnapshots, type ServerSnapshot } from "../lib/server-sync";

interface BackupSummary {
  name: string;
  createdAt: number;
  entityCount: number;
  relationCount: number;
  error?: string;
}

interface PasskeySummary {
  id: string;
  label: string;
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}

interface NotificationPreferences {
  enabled: boolean;
  timezone: string;
  workdayStart: string;
  workdayEnd: string;
  workdays: number[];
  briefingEnabled: boolean;
  morningBriefEnabled: boolean;
  morningBriefTime: string;
  eveningReviewEnabled: boolean;
  eveningReviewTime: string;
  briefingWorkspaceId: string;
  briefingPush: boolean;
  briefingTelegram: boolean;
  dailyTaskCapacity: number;
}

interface ExecutiveBriefing {
  id: string;
  kind: "morning" | "evening";
  workspaceId: string;
  workspaceName: string;
  localDate: string;
  title: string;
  summary: string;
  topTasks: Array<{ id: string; title: string; reason: string }>;
  overdueCount: number;
  riskCount: number;
  completedCount: number;
  remainingCount: number;
  capacity: number;
  overloaded: boolean;
  suggestions: string[];
  createdAt: number;
}

interface CalendarSourceState {
  id: string;
  workspaceId: string;
  label: string;
  status: string;
  configured: boolean;
  lastSyncAt: number | null;
  lastSuccessAt: number | null;
  lastError: string;
  eventCount: number;
  revision: number;
}

interface CalendarEvent {
  id: string;
  sourceId: string;
  workspaceId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  status: string;
  busy: boolean;
  private: boolean;
}

interface NotificationState {
  publicKey: string;
  subscriptionCount: number;
  preferences: NotificationPreferences;
}

interface AIProposal {
  id: string;
  summary: string;
  changes: Array<{ label: string; value: string }>;
  expiresAt: number;
}

interface AssistantMessage extends AIMessage {
  proposal?: AIProposal;
  actionId?: string;
  resolved?: boolean;
}

const views = [
    "Home",
    "Inbox",
    "Today",
    "Overdue",
    "Upcoming",
    "Anytime",
    "Someday",
    "Completed",
    "Projects",
    "Areas",
    "Notes",
  ];
const moreViews = [
  "Inbox",
  "Overdue",
  "Upcoming",
  "Anytime",
  "Someday",
  "Completed",
  "Areas",
  "Notes",
  "Settings",
];
const viewIcons: Record<string, string> = {
  Home: "⌂",
  Inbox: "↓",
  Today: "○",
  Overdue: "!",
  Upcoming: "→",
  Anytime: "•",
  Someday: "☾",
  Completed: "✓",
  Projects: "◇",
  Areas: "◎",
  Notes: "▤",
  Settings: "⚙",
  More: "•••",
};
const mobileViews = ["Home", "Today", "+", "Projects", "More"];
const ymd = (d = new Date()) =>
  [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
const addLocalDays = (date: Date, days: number) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};
const toLocalDateTime = (value: unknown) => {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.length === 16 ? value : "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};
const fromLocalDateTime = (value: string) =>
  value ? new Date(value).toISOString() : "";
const zonedDateTimeToIso = (dateValue: string, timeValue: string, timeZone: string) => {
  const [year, month, date] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, date, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let candidate = desired;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const values = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
    );
    candidate += desired - represented;
  }
  return new Date(candidate).toISOString();
};
const urlBase64ToUint8Array = (base64: string) => {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
};

export default function App() {
  const [items, setItems] = useState<Entity[]>([]),
    [relations, setRelations] = useState<any[]>([]),
    [view, setView] = useState("Today"),
    [text, setText] = useState(""),
    [selected, setSelected] = useState<Entity | null>(null),
    [query, setQuery] = useState(""),
    [capture, setCapture] = useState(false),
    [captureType, setCaptureType] = useState<"task" | "note">("task"),
    [captureProjectId, setCaptureProjectId] = useState(""),
    [draft, setDraft] = useState(""),
    [undo, setUndo] = useState<Entity | null>(null),
    [context, setContext] = useState<ContextBundle | null>(null),
    [assistantOpen, setAssistantOpen] = useState(false),
    [moreOpen, setMoreOpen] = useState(false),
    [startupView, setStartupView] = useState("Today"),
    [workspaceDraft, setWorkspaceDraft] = useState("Personal"),
    [newWorkspaceDraft, setNewWorkspaceDraft] = useState(""),
    [activeWorkspaceId, setActiveWorkspaceId] = useState("personal"),
    [writeWorkspaceId, setWriteWorkspaceId] = useState("personal"),
    [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false),
    [settingsSaved, setSettingsSaved] = useState(false),
    [syncStatus, setSyncStatus] = useState<
      "connecting" | "synced" | "syncing" | "offline"
    >("connecting"),
    [backups, setBackups] = useState<BackupSummary[]>([]),
    [backupStatus, setBackupStatus] = useState(""),
    [standalone, setStandalone] = useState(false),
    [notificationState, setNotificationState] = useState<NotificationState | null>(null),
    [notificationStatus, setNotificationStatus] = useState(""),
    [briefings, setBriefings] = useState<ExecutiveBriefing[]>([]),
    [briefingBusy, setBriefingBusy] = useState(false),
    [calendarSources, setCalendarSources] = useState<CalendarSourceState[]>([]),
    [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]),
    [calendarLabel, setCalendarLabel] = useState("Outlook calendar"),
    [calendarUrl, setCalendarUrl] = useState(""),
    [calendarBusy, setCalendarBusy] = useState(false),
    [calendarStatus, setCalendarStatus] = useState(""),
    [sortBy, setSortBy] = useState<"date" | "priority" | "created">("date"),
    [priorityFilter, setPriorityFilter] = useState("all"),
    [checklistDraft, setChecklistDraft] = useState(""),
    [authState, setAuthState] = useState<
      "checking" | "ready" | "required" | "misconfigured"
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
  const deepLinkHandled = useRef(false);
  const captureOpener = useRef<HTMLElement | null>(null);
  const captureModalRef = useRef<HTMLFormElement | null>(null);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const notificationSettingsQueue = useRef<Promise<void>>(Promise.resolve());
  const localDataVersion = useRef(0);
  const calendarLoadVersion = useRef(0);
  const calendarWorkspaceSelection = useRef("personal");
  calendarWorkspaceSelection.current = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
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
    if (expectedVersion !== undefined && localDataVersion.current !== expectedVersion) return false;
    await db.transaction("rw", db.entities, db.relations, async () => {
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
  async function syncToServer() {
    const operation = syncQueue.current.then(async () => {
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
      if (response.status === 409) {
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
        serverRevision.current = saved.revision;
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
  useEffect(() => {
    setPasskeySupported(browserSupportsWebAuthn());
    fetch("/api/auth/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((state) => {
        setAuthEnabled(Boolean(state.enabled));
        if (state.enabled && state.configured === false) {
          setAuthError("Authentication must be configured on the server before this app can be used.");
          setAuthState("misconfigured");
          return;
        }
        setAuthState(state.authenticated ? "ready" : "required");
      })
      .catch(() => {
        setAuthError("Authentication status is unavailable.");
        setAuthState("required");
      });
  }, []);

  async function loadBriefings(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const response = await fetch(`/api/executive?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Executive briefing is unavailable");
    const data = await response.json();
    setBriefings(Array.isArray(data.briefings) ? data.briefings : []);
  }

  async function runBriefing(kind: "morning" | "evening") {
    if (briefingBusy) return;
    setBriefingBusy(true);
    setNotificationStatus("");
    try {
      const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
      const response = await fetch("/api/executive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, workspaceId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Briefing failed");
      await loadBriefings(workspaceId);
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : "Briefing failed");
    } finally {
      setBriefingBusy(false);
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
      setCalendarStatus(action === "connect" ? "Kalendář je připojený pouze pro čtení." : action === "refresh" ? "Kalendář byl obnoven." : "Kalendář byl odpojen a jeho data odstraněna.");
    } catch (error) {
      setCalendarUrl("");
      await loadCalendar(workspaceId).catch(() => undefined);
      setCalendarStatus(error instanceof Error ? error.message : "Calendar action failed");
    } finally {
      setCalendarBusy(false);
    }
  }

  useEffect(() => {
    if (authState !== "ready") return;
    loadBriefings().catch(() => undefined);
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setCalendarSources([]);
    setCalendarEvents([]);
    loadCalendar(workspaceId).catch(() => undefined);
  }, [authState, activeWorkspaceId, writeWorkspaceId]);

  useEffect(() => {
    if (view !== "Settings" || authState !== "ready") return;
    loadPasskeys().catch(() => setPasskeyStatus("Passkeys could not be loaded."));
  }, [view, authState]);

  useEffect(() => {
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
          serverRevision.current = snapshot.revision;
          await syncToServer();
          return;
        }
        await applySnapshot(snapshot, initializationVersion);
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
    if (!window.confirm("Remove this passkey? Password sign-in will remain available.")) return;
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

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthState("required");
  }

  useEffect(() => {
    fetch("/api/notifications", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((state) => setNotificationState(state as NotificationState))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!items.length || deepLinkHandled.current) return;
    const parameters = new URLSearchParams(window.location.search);
    const requestedView = parameters.get("view");
    const taskId = parameters.get("task");
    if (requestedView && views.includes(requestedView)) setView(requestedView);
    if (taskId) {
      const task = items.find((item) => item.id === taskId);
      if (task && task.type !== "workspace") {
        selectWorkspace(task.workspaceId);
        inspect(task);
      }
    }
    deepLinkHandled.current = true;
  }, [items]);

  useEffect(() => {
    if (!capture && captureOpener.current) {
      captureOpener.current.focus();
      captureOpener.current = null;
    }
  }, [capture]);

  useEffect(() => {
    if (view !== "Settings") return;
    Promise.all([
      fetch("/api/backups", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/notifications", { cache: "no-store" }).then((response) => response.json()),
    ])
      .then(([backupData, notificationData]) => {
        setBackups(Array.isArray(backupData.backups) ? backupData.backups : []);
        setNotificationState(notificationData as NotificationState);
      })
      .catch(() => setBackupStatus("Server settings are unavailable while offline."));
  }, [view]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") pullFromServer();
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
    if (workspace) setWorkspaceDraft(workspace.title);
  }, [activeWorkspaceId, items, writeWorkspaceId]);

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
    if (
      !window.confirm(
        `Restore ${new Date(backup.createdAt).toLocaleString()}? A safety backup will be created first.`,
      )
    )
      return;
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
        ? "All my work"
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
  const calendarTimezone = notificationState?.preferences.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const calendarTodayParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: calendarTimezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const calendarToday = `${calendarTodayParts.year}-${calendarTodayParts.month}-${calendarTodayParts.day}`;
  const dayStart = Date.parse(zonedDateTimeToIso(calendarToday, notificationState?.preferences.workdayStart || "08:00", calendarTimezone));
  const dayEnd = Date.parse(zonedDateTimeToIso(calendarToday, notificationState?.preferences.workdayEnd || "18:00", calendarTimezone));
  const todayCalendarEvents = calendarEvents.filter((event) => Date.parse(event.end) > dayStart && Date.parse(event.start) < dayEnd);
  const calendarFresh = calendarSources.length > 0 && calendarSources.every((source) => source.status === "ready");
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
    .filter((task) => task.status === "open" && (
      task.properties.today === true || task.properties.when === today ||
      (typeof task.properties.when === "string" && task.properties.when < today)
    ))
    .sort((a, b) => String(a.properties.when || today).localeCompare(String(b.properties.when || today)))
    .slice(0, 5);
  const homeUpcomingTasks = tasks
    .filter((task) => task.status === "open" && typeof task.properties.when === "string" && task.properties.when > today)
    .sort((a, b) => String(a.properties.when).localeCompare(String(b.properties.when)))
    .slice(0, 4);
  const homeProjects = projects.filter((project) => project.status === "active").slice(0, 4);
  const homeRecent = [...scopedItems]
    .filter((entity) => entity.type !== "task" || entity.status === "open")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);
  const greetingHour = new Date().getHours();
  const homeGreeting = greetingHour < 12 ? "Good morning" : greetingHour < 18 ? "Good afternoon" : "Good evening";
  const visible = useMemo(
    () => {
      const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
      return tasks.filter((t) => {
        if (priorityFilter !== "all" && String(t.properties.priority || "none") !== priorityFilter) return false;
        if (view === "Completed") return t.status === "completed";
        if (t.status !== "open") return false;
        const p = t.properties;
        if (view === "Inbox") return p.inbox === true;
        if (view === "Today") return p.today === true || p.when === today || (typeof p.when === "string" && p.when < today);
        if (view === "Overdue") return typeof p.when === "string" && p.when < today;
        if (view === "Upcoming")
          return typeof p.when === "string" && p.when > today;
        if (view === "Anytime")
          return !p.when && !p.someday && p.inbox !== true;
        if (view === "Someday") return p.someday === true;
        return true;
      }).sort((a, b) => {
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
    let title = raw.trim(),
      when = "",
      priority = "none";
    if (/(^|\s)zítra(?=\s|$)/i.test(title)) {
      when = ymd(addLocalDays(new Date(), 1));
      title = title.replace(/(^|\s)zítra(?=\s|$)/i, " ");
    } else if (/(^|\s)dnes(?=\s|$)/i.test(title)) {
      when = today;
      title = title.replace(/(^|\s)dnes(?=\s|$)/i, " ");
    }
    const m = title.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\.?\s*$/);
    if (m) {
      const now = new Date();
      const year = m[3] ? Number(m[3]) : now.getFullYear();
      const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
      if (d.getFullYear() === year && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[1])) {
        if (!m[3] && d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d.setFullYear(year + 1);
        when = ymd(d);
        title = title.slice(0, m.index).trim();
      }
    }
    if (/(^|\s)(!|#high)(?=\s|$)/i.test(title)) priority = "high";
    else if (/(^|\s)#medium(?=\s|$)/i.test(title)) priority = "medium";
    else if (/(^|\s)#low(?=\s|$)/i.test(title)) priority = "low";
    title = title.replace(/(^|\s)(!|#high|#medium|#low)(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
    return { title, when, priority };
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
      properties = { ...extra },
      parsed =
        type === "task"
          ? parseCapture(title)
          : { title: title.trim(), when: "", priority: "none" };
    const linkedProject = projectId ? await db.entities.get(projectId) : null;
    const linkedArea = areaId ? await db.entities.get(areaId) : null;
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
    localDataVersion.current += 1;
    let created = false;
    await db.transaction("rw", db.entities, db.relations, async () => {
      if (await db.entities.get(id)) return;
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
                inbox: parsed.when
                  ? false
                  : Boolean(properties.inbox ?? (!projectId && view === "Inbox")),
                today: parsed.when
                  ? parsed.when === today
                  : Boolean(properties.today ?? (view === "Today")),
                ...(parsed.when ? { when: parsed.when } : {}),
                ...(parsed.priority !== "none" ? { priority: parsed.priority } : {}),
                activity: [{ at: now, action: "created" }],
              }
            : properties,
        createdAt: now,
        updatedAt: now,
      });
      created = true;
      if (projectId) {
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: creationWorkspaceId,
          sourceEntityId: id,
          targetEntityId: projectId,
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
    localDataVersion.current += 1;
    if (!created) return id;
    setText("");
    setDraft("");
    await syncToServer();
    await load();
    if (selected) {
      setSelected((await db.entities.get(selected.id)) || null);
      setContext(await buildContext(selected.id, 2));
    }
    return id;
  }

  function openCapture(type: "task" | "note" = "task", projectId = "") {
    captureOpener.current = document.activeElement as HTMLElement | null;
    setCaptureType(type);
    setCaptureProjectId(projectId);
    setDraft("");
    setCapture(true);
  }
  async function submitCapture() {
    const title = draft.trim();
    if (!title) return;
    const globalTask = captureType === "task" && !captureProjectId;
    setCapture(false);
    if (globalTask) {
      closeDetail();
      setMoreOpen(false);
      setView("Inbox");
    }
    try {
      await create(captureType, title, {
        ...(captureProjectId ? { projectId: captureProjectId } : {}),
        ...(captureType === "task"
          ? { inbox: !captureProjectId, today: false }
          : {}),
      });
    } catch {
      setDraft(title);
      setCapture(true);
      setSyncStatus("offline");
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
    setUndo(e);
    const deletedIds = new Set(pendingDeletedIds());
    deletedIds.add(e.id);
    localStorage.setItem(deletedKey, JSON.stringify([...deletedIds]));
    const linkedRelations = (await db.relations.toArray())
      .filter(
        (relation) =>
          relation.sourceEntityId === e.id || relation.targetEntityId === e.id,
      )
      .map((relation) => relation.id);
    localDataVersion.current += 1;
    await db.transaction("rw", db.entities, db.relations, async () => {
      await db.entities.delete(e.id);
      await db.relations.bulkDelete(linkedRelations);
    });
    localDataVersion.current += 1;
    await syncToServer();
    closeDetail();
    load();
  }
  async function restore() {
    if (!undo) return;
    const deletedIds = pendingDeletedIds().filter((id) => id !== undo.id);
    if (deletedIds.length)
      localStorage.setItem(deletedKey, JSON.stringify(deletedIds));
    else localStorage.removeItem(deletedKey);
    localDataVersion.current += 1;
    await db.entities.put({
      ...undo,
      status: undo.status === "completed" ? "open" : undo.status,
      updatedAt: Date.now(),
    });
    localDataVersion.current += 1;
    const revivedIds = new Set(pendingRevivedIds());
    revivedIds.add(undo.id);
    localStorage.setItem(revivedKey, JSON.stringify([...revivedIds]));
    await syncToServer();
    setUndo(null);
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
  async function done(id: string) {
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
    if (t) setUndo(t);
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
    ? scopedItems.filter((x) => x.type === type)
    : visible;
  if (authState !== "ready") {
    return (
      <main className="authShell">
        <form className="authCard" onSubmit={login}>
          <div className="authMark">◇</div>
          <p className="eyebrow">AI EXECUTIVE</p>
          <h1>
            {authState === "checking"
              ? "Checking access…"
              : authState === "misconfigured"
                ? "Setup required"
                : "Sign in"}
          </h1>
          {authState === "required" && (
            <>
              <label>
                Password
                <input
                  autoFocus
                  type="password"
                  autoComplete="current-password"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                />
              </label>
              <button type="submit" disabled={!authPassword}>Sign in</button>
              {passkeySupported && (
                <button
                  className="secondaryAction"
                  type="button"
                  disabled={passkeyBusy}
                  onClick={signInWithPasskey}
                >
                  {passkeyBusy ? "Checking…" : "Sign in with passkey"}
                </button>
              )}
            </>
          )}
          {authError && <p className="authError" role="alert">{authError}</p>}
        </form>
      </main>
    );
  }
  return (
    <main className="appShell">
      <aside>
        <div className="appIdentity" aria-label="AI Executive">
          <span className="brandMark">◇</span>
          <span><strong>AI Executive</strong><small>Personal OS</small></span>
        </div>
        <div className="workspaceSwitcher">
          <button
            className="workspaceButton"
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
            aria-label="Switch workspace"
            aria-expanded={workspaceMenuOpen}
          >
            <b>{workspaceName}</b>
            <span>⌄</span>
          </button>
          {workspaceMenuOpen && (
            <div className="workspaceMenu">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className={activeWorkspaceId === workspace.workspaceId ? "active" : ""}
                  onClick={() => selectWorkspace(workspace.workspaceId)}
                >
                  <span>{workspace.title}</span>
                  <small>{String(workspace.properties.kind || "shared")}</small>
                </button>
              ))}
              <button
                className={activeWorkspaceId === "all" ? "active" : ""}
                onClick={() => selectWorkspace("all")}
              >
                <span>All my work</span>
                <small>aggregate</small>
              </button>
              <button
                onClick={() => {
                  setView("Settings");
                  setWorkspaceMenuOpen(false);
                  closeDetail();
                }}
              >
                <span>Manage workspaces</span>
                <small>settings</small>
              </button>
            </div>
          )}
        </div>
        <nav>
          {views.map((x) => (
            <button
              className={view === x ? "active" : ""}
              onClick={() => {
                setView(x);
                closeDetail();
              }}
              key={x}
            >
              <span className="navLabel"><span aria-hidden="true">{viewIcons[x]}</span>{x}</span>
              {x === "Today" ? (
                <span>
                  {
                    tasks.filter(
                      (t) =>
                        t.status === "open" &&
                        (t.properties.today === true ||
                          t.properties.when === today),
                    ).length
                  }
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <footer className="sidebarActions">
          <button onClick={() => openCapture()} aria-label="Create a new task">
            ＋ New
          </button>
          <button
            className={view === "Settings" ? "active" : ""}
            onClick={() => {
              setView("Settings");
              closeDetail();
            }}
          >
            ⚙ Settings
          </button>
        </footer>
      </aside>
      <section className="appPane">
        <header className="topbar">
          <button
            className="mobileWorkspaceButton"
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
            aria-label="Switch workspace"
          >
            {workspaceName}⌄
          </button>
          {workspaceMenuOpen && (
            <div className="mobileWorkspaceMenu workspaceMenu">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  onClick={() => selectWorkspace(workspace.workspaceId)}
                >
                  {workspace.title}
                </button>
              ))}
              <button onClick={() => selectWorkspace("all")}>All my work</button>
            </div>
          )}
          <label className="searchField">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setView("Search")}
              placeholder="Search everything"
              aria-label="Search"
            />
            <kbd>⌘ K</kbd>
          </label>
          <button
            className="aiButton"
            onClick={() => setAssistantOpen(true)}
            aria-label="Ask AI"
          >
            ◇ Ask AI
          </button>
        </header>
        <div className="content">
          <div className="pageIntro">
            <p className="eyebrow">
              {workspaceName.toUpperCase()} · {activeWorkspaceId === "all" ? "AGGREGATE" : String(activeWorkspace?.properties.kind || "PERSONAL").toUpperCase()}
            </p>
            <div className="pageTitleRow">
              <h1>{view === "Home" ? homeGreeting : view}</h1>
              {view === "Today" && <time>{new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date())}</time>}
            </div>
            {view === "Home" && <p className="pageSubtitle">Here is the shape of your day.</p>}
          </div>
          {view === "Home" && (
            <>
            <div className="homeOverview">
              <section className="homeSection homePrimary">
                <div className="homeSectionHead">
                  <span><span className="sectionDot todayDot" />Today</span>
                  <button onClick={() => setView("Today")}>See all <span aria-hidden="true">→</span></button>
                </div>
                <div className="homeTaskList">
                  {homeTodayTasks.map((task) => (
                    <article key={task.id} onClick={() => inspect(task)}>
                      <button className="check" aria-label={`Complete ${task.title}`} onClick={(event) => { event.stopPropagation(); done(task.id); }}>○</button>
                      <div><strong>{task.title}</strong><small>{task.properties.when && task.properties.when < today ? "Overdue" : task.properties.priority && task.properties.priority !== "none" ? String(task.properties.priority) : "Today"}</small></div>
                    </article>
                  ))}
                  {homeTodayTasks.length === 0 && <div className="calmEmpty"><span>✓</span><p>Nothing planned for today.</p><button onClick={() => openCapture()}>Add a task</button></div>}
                </div>
              </section>
              <div className="homeSide">
                <section className="homeSection">
                  <div className="homeSectionHead"><span><span className="sectionDot inboxDot" />Inbox</span><b>{tasks.filter((task) => task.status === "open" && task.properties.inbox === true).length}</b></div>
                  <p>Items waiting to be organized.</p>
                  <button className="textAction" onClick={() => setView("Inbox")}>Open inbox →</button>
                </section>
                <section className="homeSection">
                  <div className="homeSectionHead"><span><span className="sectionDot projectDot" />Projects</span><button onClick={() => setView("Projects")}>See all →</button></div>
                  <div className="homeCompactList">
                    {homeProjects.map((project) => <button key={project.id} onClick={() => inspect(project)}><span>{project.title}</span><small>{tasks.filter((task) => task.status === "open" && sources(project.id, "belongs_to_project").includes(task.id)).length} open</small></button>)}
                    {homeProjects.length === 0 && <p>No active projects.</p>}
                  </div>
                </section>
              </div>
              <section className="homeSection">
                <div className="homeSectionHead"><span><span className="sectionDot upcomingDot" />Upcoming</span><button onClick={() => setView("Upcoming")}>See all →</button></div>
                <div className="homeCompactList">
                  {homeUpcomingTasks.map((task) => <button key={task.id} onClick={() => inspect(task)}><span>{task.title}</span><small>{new Date(`${task.properties.when}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</small></button>)}
                  {homeUpcomingTasks.length === 0 && <p>Nothing scheduled yet.</p>}
                </div>
              </section>
              <section className="homeSection">
                <div className="homeSectionHead"><span><span className="sectionDot recentDot" />Recent</span></div>
                <div className="homeCompactList">
                  {homeRecent.map((entity) => <button key={entity.id} onClick={() => inspect(entity)}><span>{entity.title}</span><small>{entity.type}</small></button>)}
                </div>
              </section>
            </div>
            <div className="homeInsights">
            <section className="briefingCard">
              <div className="sectionHeading">
                <div>
                  <p className="eyebrow">PROACTIVE EXECUTIVE</p>
                  <h2>{briefings[0]?.title || "Denní přehled"}</h2>
                </div>
                <div className="notificationActions">
                  <button onClick={() => runBriefing("morning")} disabled={briefingBusy}>Ranní přehled</button>
                  <button onClick={() => runBriefing("evening")} disabled={briefingBusy}>Večerní rekapitulace</button>
                </div>
              </div>
              {briefings[0] ? (
                <div>
                  <p>{briefings[0].summary}</p>
                  {briefings[0].overloaded && <p role="status"><strong>Kapacita je překročena.</strong> Jde o orientační odhad bez kalendáře a časových odhadů.</p>}
                  <ol className="briefingTasks">
                    {briefings[0].topTasks.map((task) => (
                      <li key={task.id}>
                        <button onClick={() => {
                          const entity = items.find((item) => item.id === task.id);
                          if (entity) inspect(entity);
                        }}>{task.title}</button>
                        <small>{task.reason}</small>
                      </li>
                    ))}
                  </ol>
                  <ul>{briefings[0].suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>
                  <small>{new Date(briefings[0].createdAt).toLocaleString()} · {briefings[0].workspaceName}</small>
                </div>
              ) : <p>Vytvoř první přehled, nebo zapni automatický plán v Settings.</p>}
            </section>
            <section className="briefingCard calendarCard">
              <div className="sectionHeading">
                <div>
                  <p className="eyebrow">CALENDAR · {activeWorkspaceId === "all" ? writeWorkspace?.title || "PERSONAL" : workspaceName} · READ ONLY</p>
                  <h2>Dnešní kapacita</h2>
                </div>
                <strong>{calendarSources.length === 0 ? "Kalendář není připojen" : calendarFresh ? `${freeHours.toFixed(1)} h volno` : "Kapacita neověřená"}</strong>
              </div>
              {calendarSources.some((source) => source.status !== "ready") && (
                <p role="status">Dostupnost kalendáře je neznámá nebo zastaralá. Plán podle volných bloků nyní nepoužívej.</p>
              )}
              {calendarFresh && todayCalendarEvents.length === 0 && <p>V pracovní době dnes nemáš žádnou blokující událost.</p>}
              <div className="calendarAgenda">
                {todayCalendarEvents.map((event) => (
                  <div key={event.id} className={event.busy ? "busy" : "free"}>
                    <span>{event.allDay ? "Celý den" : new Date(event.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}</span>
                    <strong>{event.title}</strong>
                    <small>{event.busy ? "obsazeno" : "volný čas"}</small>
                  </div>
                ))}
              </div>
              {calendarFresh && freeWindows.length > 0 && (
                <p>
                  <strong>Nejbližší volné bloky:</strong>{" "}
                  {freeWindows.slice(0, 3).map((window) => `${new Date(window[0]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}–${new Date(window[1]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}`).join(", ")}
                </p>
              )}
              <small>Události jsou pouze pro čtení. Překryvy se do obsazeného času počítají jen jednou.</small>
            </section>
            </div>
            </>
          )}
          {view === "Search" && query && (
            <div className="searchResults">
              {scopedItems
                .filter((x) => {
                  const q = query.toLowerCase(),
                    linked = scopedRelations
                      .filter(
                        (r) =>
                          r.sourceEntityId === x.id ||
                          r.targetEntityId === x.id,
                      )
                      .flatMap((r) => [
                        scopedItems.find((i) => i.id === r.sourceEntityId)?.title ||
                          "",
                        scopedItems.find((i) => i.id === r.targetEntityId)?.title ||
                          "",
                      ])
                      .join(" ");
                  return (x.title + " " + (x.content || "") + " " + linked)
                    .toLowerCase()
                    .includes(q);
                })
                .map((x) => (
                  <article key={x.id} onClick={() => inspect(x)}>
                    <div>
                      <strong>{x.title}</strong>
                      <small>{x.type}</small>
                    </div>
                  </article>
                ))}
            </div>
          )}
          {view === "Settings" && (
            <div className="settingsPanel">
              <section>
                <h2>Workspace</h2>
                <label>
                  Current view
                  <select
                    value={activeWorkspaceId}
                    onChange={(event) => selectWorkspace(event.target.value)}
                  >
                    {workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.workspaceId}>
                        {workspace.title}
                      </option>
                    ))}
                    <option value="all">All my work</option>
                  </select>
                </label>
                {activeWorkspaceId === "all" && (
                  <label>
                    Create new items in
                    <select
                      value={writeWorkspaceId}
                      onChange={(event) => selectWriteWorkspace(event.target.value)}
                    >
                      {workspaces.map((workspace) => (
                        <option key={workspace.id} value={workspace.workspaceId}>
                          {workspace.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Workspace name
                  <div className="workspaceNameEditor">
                    <input
                      value={workspaceDraft}
                      maxLength={120}
                      onChange={(e) => {
                        setWorkspaceDraft(e.target.value);
                        setSettingsSaved(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveWorkspaceName();
                      }}
                      aria-label="Workspace name"
                    />
                    <button
                      onClick={saveWorkspaceName}
                      disabled={!workspaceDraft.trim()}
                    >
                      Save
                    </button>
                  </div>
                </label>
                {settingsSaved && (
                  <p className="saveConfirmation" role="status">
                    Workspace saved.
                  </p>
                )}
                <div className="workspaceSummary">
                  <span>
                    {String(writeWorkspace?.properties.kind || "personal")} workspace
                  </span>
                  <span>
                    Role: {String(writeWorkspace?.properties.role || "owner")}
                  </span>
                </div>
                <label>
                  New shared workspace
                  <div className="workspaceNameEditor">
                    <input
                      value={newWorkspaceDraft}
                      maxLength={120}
                      onChange={(event) => setNewWorkspaceDraft(event.target.value)}
                      placeholder="Family or Work"
                      aria-label="New workspace name"
                    />
                    <button
                      onClick={createWorkspace}
                      disabled={!newWorkspaceDraft.trim()}
                    >
                      Create
                    </button>
                  </div>
                </label>
                <p>
                  Shared workspaces are ready for separate data and roles. Inviting
                  another account will be enabled after multi-user identity is added.
                </p>
                <label>
                  Open on startup
                  <select
                    value={startupView}
                    onChange={(e) => {
                      setStartupView(e.target.value);
                      localStorage.setItem(
                        "ai-executive-startup-view",
                        e.target.value,
                      );
                    }}
                  >
                    {views
                      .filter((item) => item !== "Home")
                      .map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                  </select>
                </label>
              </section>
              <section>
                <h2>Data & AI</h2>
                <p>
                  Your workspace data is stored in the server database and
                  cached locally for fast access. AI uses the server provider
                  when configured and falls back to a local preview otherwise.
                </p>
                <dl>
                  <div>
                    <dt>Stored items</dt>
                    <dd>{scopedItems.length}</dd>
                  </div>
                  <div>
                    <dt>Relations</dt>
                    <dd>{scopedRelations.length}</dd>
                  </div>
                  <div>
                    <dt>Server sync</dt>
                    <dd className={`syncStatus ${syncStatus}`}>
                      {syncStatus === "synced"
                        ? "Synced"
                        : syncStatus === "syncing"
                          ? "Syncing…"
                          : syncStatus === "offline"
                            ? "Offline"
                            : "Connecting…"}
                    </dd>
                  </div>
                </dl>
              </section>
              <section>
                <h2>Install app</h2>
                <p>
                  {standalone
                    ? "AI Executive is running as an installed app."
                    : "On iPhone, use Share → Add to Home Screen. On Mac, use your browser’s Install or Add to Dock command."}
                </p>
                <span className={`installStatus ${standalone ? "installed" : ""}`}>
                  {standalone ? "Installed" : "Browser mode"}
                </span>
              </section>
              {authEnabled && (
                <section>
                  <h2>Access</h2>
                  <p>This device has an authenticated owner session.</p>
                  {passkeySupported && (
                    <>
                      <label>
                        Passkey name
                        <input
                          value={passkeyLabel}
                          maxLength={80}
                          onChange={(event) => setPasskeyLabel(event.target.value)}
                          placeholder="Kryštof’s iPhone"
                        />
                      </label>
                      <label>
                        Confirm current password
                        <input
                          type="password"
                          autoComplete="current-password"
                          value={passkeyPassword}
                          maxLength={1024}
                          onChange={(event) => setPasskeyPassword(event.target.value)}
                        />
                      </label>
                      <button
                        className="primaryAction"
                        onClick={registerPasskey}
                        disabled={passkeyBusy || !passkeyLabel.trim() || !passkeyPassword}
                      >
                        {passkeyBusy ? "Waiting for device…" : "Add passkey"}
                      </button>
                      <div className="passkeyList">
                        {passkeys.map((passkey) => (
                          <div key={passkey.id} className="passkeyRow">
                            <span>
                              <strong>{passkey.label}</strong>
                              <small>
                                {passkey.rpId} · added {new Date(passkey.createdAt).toLocaleDateString()}
                                {passkey.backedUp ? " · synced" : ""}
                              </small>
                            </span>
                            <button onClick={() => removePasskey(passkey.id)}>Remove</button>
                          </div>
                        ))}
                      </div>
                      {passkeyStatus && <p role="status">{passkeyStatus}</p>}
                      <p>
                        Passkeys are tied to this address. Use the same HTTPS address on
                        iPhone and Mac for an iCloud-synced passkey.
                      </p>
                    </>
                  )}
                  <button className="secondaryAction" onClick={logout}>Sign out</button>
                </section>
              )}
              <section>
                <div className="sectionHeading">
                  <div>
                    <h2>Reminders</h2>
                    <p>
                      Push reminders are sent by the server even when the app is closed.
                      On iPhone, first install the app on the Home Screen and open the HTTPS address.
                    </p>
                  </div>
                  <span className={`installStatus ${notificationState?.subscriptionCount ? "installed" : ""}`}>
                    {notificationState?.subscriptionCount
                      ? `${notificationState.subscriptionCount} device${notificationState.subscriptionCount === 1 ? "" : "s"}`
                      : "No device"}
                  </span>
                </div>
                <div className="notificationActions">
                  <button className="primaryAction" onClick={enableNotifications}>Enable on this device</button>
                  <button onClick={testNotification}>Send test</button>
                  <button onClick={disableNotifications}>Disable this device</button>
                </div>
                {notificationState && (
                  <div className="preferenceGrid">
                    <label className="preferenceToggle">
                      <input
                        type="checkbox"
                        checked={notificationState.preferences.enabled}
                        onChange={(event) => saveNotificationSettings({
                          ...notificationState.preferences,
                          enabled: event.target.checked,
                        })}
                      />
                      Send scheduled reminders
                    </label>
                    <label>
                      Timezone
                      <input
                        value={notificationState.preferences.timezone}
                        onChange={(event) => setNotificationState({
                          ...notificationState,
                          preferences: { ...notificationState.preferences, timezone: event.target.value },
                        })}
                        onBlur={() => saveNotificationSettings(notificationState.preferences)}
                      />
                    </label>
                    <label>
                      Workday starts
                      <input
                        type="time"
                        value={notificationState.preferences.workdayStart}
                        onChange={(event) => saveNotificationSettings({
                          ...notificationState.preferences,
                          workdayStart: event.target.value,
                        })}
                      />
                    </label>
                    <label>
                      Workday ends
                      <input
                        type="time"
                        value={notificationState.preferences.workdayEnd}
                        onChange={(event) => saveNotificationSettings({
                          ...notificationState.preferences,
                          workdayEnd: event.target.value,
                        })}
                      />
                    </label>
                    <fieldset>
                      <legend>Working days</legend>
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, day) => (
                        <label key={label}>
                          <input
                            type="checkbox"
                            checked={notificationState.preferences.workdays.includes(day)}
                            onChange={() => {
                              const workdays = notificationState.preferences.workdays.includes(day)
                                ? notificationState.preferences.workdays.filter((value) => value !== day)
                                : [...notificationState.preferences.workdays, day].sort();
                              saveNotificationSettings({ ...notificationState.preferences, workdays });
                            }}
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                  </div>
                )}
                {notificationStatus && <p role="status">{notificationStatus}</p>}
              </section>
              <section>
                <div className="sectionHeading">
                  <div>
                    <h2>Calendar · read only</h2>
                    <p>
                      Připoj soukromý HTTPS odkaz ve formátu ICS. Adresa se na
                      serveru šifruje, po uložení se už do prohlížeče nevrací a
                      AI Executive nemůže kalendář měnit.
                    </p>
                  </div>
                  <span className={`installStatus ${calendarSources.some((source) => source.status === "ready") ? "installed" : ""}`}>
                    {calendarSources.some((source) => source.status === "ready") ? "Read only" : "Not connected"}
                  </span>
                </div>
                <div className="calendarConnect">
                  <label>
                    Název zdroje
                    <input value={calendarLabel} maxLength={120} onChange={(event) => setCalendarLabel(event.target.value)} />
                  </label>
                  <label>
                    Soukromý ICS odkaz
                    <input type="password" autoComplete="off" value={calendarUrl} maxLength={8192}
                      placeholder="https://…/calendar.ics"
                      onChange={(event) => setCalendarUrl(event.target.value)} />
                  </label>
                  <button className="primaryAction" disabled={calendarBusy || !calendarLabel.trim() || !calendarUrl.trim()}
                    onClick={() => calendarAction("connect")}>Připojit a načíst</button>
                </div>
                <div className="calendarSources">
                  {calendarSources.map((source) => (
                    <div key={source.id}>
                      <span>
                        <strong>{source.label}</strong>
                        <small>
                          {source.status === "ready" ? `${source.eventCount} událostí` : "Synchronizace selhala"}
                          {source.lastSuccessAt ? ` · naposledy ${new Date(source.lastSuccessAt).toLocaleString()}` : ""}
                        </small>
                        {source.lastError && <small role="status">{source.lastError}</small>}
                      </span>
                      <div className="notificationActions">
                        <button disabled={calendarBusy} onClick={() => calendarAction("refresh", source.id)}>Obnovit</button>
                        <button disabled={calendarBusy} onClick={() => {
                          if (window.confirm(`Odpojit kalendář „${source.label}“ a odstranit jeho lokální události?`)) calendarAction("disconnect", source.id);
                        }}>Odpojit</button>
                      </div>
                    </div>
                  ))}
                </div>
                {calendarStatus && <p role="status">{calendarStatus}</p>}
              </section>
              <section>
                <div className="sectionHeading">
                  <div>
                    <h2>Proactive executive</h2>
                    <p>
                      Automatický ranní přehled a večerní rekapitulace. Úkoly nikdy
                      nemění bez návrhu, vašeho potvrzení a možnosti Undo.
                    </p>
                  </div>
                  <button onClick={() => runBriefing("morning")} disabled={briefingBusy}>
                    Vytvořit teď
                  </button>
                </div>
                {notificationState && (
                  <div className="preferenceGrid">
                    <label className="preferenceToggle">
                      <input type="checkbox" checked={notificationState.preferences.briefingEnabled}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, briefingEnabled: event.target.checked })} />
                      Automatické denní přehledy
                    </label>
                    <label>
                      Workspace
                      <select value={notificationState.preferences.briefingWorkspaceId}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, briefingWorkspaceId: event.target.value })}>
                        {workspaces.map((workspace) => <option key={workspace.id} value={workspace.workspaceId}>{workspace.title}</option>)}
                      </select>
                    </label>
                    <label className="preferenceToggle">
                      <input type="checkbox" checked={notificationState.preferences.morningBriefEnabled}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, morningBriefEnabled: event.target.checked })} />
                      Ranní přehled
                    </label>
                    <label>
                      Čas ráno
                      <input type="time" value={notificationState.preferences.morningBriefTime}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, morningBriefTime: event.target.value })} />
                    </label>
                    <label className="preferenceToggle">
                      <input type="checkbox" checked={notificationState.preferences.eveningReviewEnabled}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, eveningReviewEnabled: event.target.checked })} />
                      Večerní rekapitulace
                    </label>
                    <label>
                      Čas večer
                      <input type="time" value={notificationState.preferences.eveningReviewTime}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, eveningReviewTime: event.target.value })} />
                    </label>
                    <label>
                      Orientační denní kapacita
                      <input type="number" min="1" max="50" value={notificationState.preferences.dailyTaskCapacity}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, dailyTaskCapacity: Number(event.target.value) })} />
                    </label>
                    <label className="preferenceToggle">
                      <input type="checkbox" checked={notificationState.preferences.briefingPush}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, briefingPush: event.target.checked })} />
                      Stručné push upozornění
                    </label>
                    <label className="preferenceToggle">
                      <input type="checkbox" checked={notificationState.preferences.briefingTelegram}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, briefingTelegram: event.target.checked })} />
                      Detail včetně názvů úkolů do nakonfigurovaného Telegram chatu
                    </label>
                  </div>
                )}
              </section>
              <section>
                <div className="sectionHeading">
                  <div>
                    <h2>Backups</h2>
                    <p>Daily safety copies are created automatically before changes.</p>
                  </div>
                  <button className="primaryAction" onClick={createServerBackup}>
                    Create backup
                  </button>
                </div>
                {backupStatus && <p role="status">{backupStatus}</p>}
                <div className="backupList">
                  {backups.length === 0 && <p>No backups yet.</p>}
                  {backups.slice(0, 8).map((backup) => (
                    <div key={backup.name}>
                      <span>
                        <strong>{new Date(backup.createdAt).toLocaleString()}</strong>
                        <small>
                          {backup.error
                            ? `Invalid backup · ${backup.error}`
                            : `${backup.entityCount} items · ${backup.relationCount} relations`}
                        </small>
                      </span>
                      <button
                        disabled={Boolean(backup.error)}
                        onClick={() => restoreServerBackup(backup)}
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
          {view !== "Settings" && (
            <>
              {!["Home", "Search", "Projects", "Areas", "Notes"].includes(view) && (
                <div className="listControls">
                  <label>
                    Priority
                    <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
                      <option value="all">All</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                      <option value="none">None</option>
                    </select>
                  </label>
                  <label>
                    Sort
                    <select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>
                      <option value="date">Date</option>
                      <option value="priority">Priority</option>
                      <option value="created">Newest</option>
                    </select>
                  </label>
                </div>
              )}
              <div
                className={
                  "list " +
                  (view === "Home" || view === "Search" ? "secondary" : "")
                }
              >
                {collection.map((x) => (
              <article key={x.id} onClick={() => inspect(x)}>
                {x.type === "task" ? (
                  <button
                    className="check"
                    onClick={(e) => {
                      e.stopPropagation();
                      done(x.id);
                    }}
                  >
                    ○
                  </button>
                ) : (
                  <div className="entityIcon">
                    {x.type === "project" ? "◆" : x.type === "area" ? "●" : "▤"}
                  </div>
                )}
                <div>
                  <strong>{x.title}</strong>
                  <small>
                    {x.type === "task"
                      ? [
                          x.properties.priority &&
                          x.properties.priority !== "none"
                            ? "● " + x.properties.priority
                            : null,
                          x.properties.when,
                          x.properties.deadline &&
                            "deadline " + x.properties.deadline,
                        ]
                          .filter(Boolean)
                          .join(" · ") ||
                        (x.properties.today === true
                          ? "Today"
                          : x.properties.someday === true
                            ? "Someday"
                            : x.properties.inbox === true
                              ? "Inbox"
                              : "Anytime")
                      : x.type}
                  </small>
                  {activeWorkspaceId === "all" && (
                    <span className="workspaceBadge">
                      {workspaces.find(
                        (workspace) => workspace.workspaceId === x.workspaceId,
                      )?.title || "Workspace"}
                    </span>
                  )}
                </div>
                  </article>
                ))}
                {collection.length === 0 && view !== "Home" && view !== "Search" && (
                  <div className="empty">Nothing here yet.</div>
                )}
              </div>
              {!['Home', 'Search'].includes(view) && (
                <div className="capture">
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && create(type, text)}
                    placeholder={"+ Add " + type}
                  />
                  <button onClick={() => create(type, text)}>Add</button>
                </div>
              )}
            </>
          )}
        </div>
      </section>
      <nav className="mobileNav">
        {mobileViews.map((x) => (
          <button
            key={x}
            className={
              (view === x || (x === "More" && moreOpen)) && x !== "+"
                ? "active"
                : ""
            }
            aria-label={x === "+" ? "Quick capture" : x}
            onClick={() => {
              if (x === "+") return openCapture();
              if (x === "More") return setMoreOpen((open) => !open);
              setMoreOpen(false);
              closeDetail();
              setView(x);
            }}
          >
            {x === "+" ? <span className="mobileAddIcon">＋</span> : <><span className="mobileNavIcon" aria-hidden="true">{viewIcons[x]}</span><span>{x}</span></>}
          </button>
        ))}
      </nav>
      {moreOpen && (
        <div className="mobileMoreBackdrop" onClick={() => setMoreOpen(false)}>
          <div className="mobileMore" onClick={(e) => e.stopPropagation()}>
            {moreViews.map((item) => (
              <button
                key={item}
                className={view === item ? "active" : ""}
                onClick={() => {
                  setView(item);
                  closeDetail();
                  setMoreOpen(false);
                }}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      )}
      {capture && (
        <div className="captureOverlay" onClick={() => setCapture(false)}>
          <form
            ref={captureModalRef}
            className="captureModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="capture-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCapture(false);
              if (e.key === "Tab") {
                const focusable = [...(captureModalRef.current?.querySelectorAll<HTMLElement>(
                  'input, button:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
                ) || [])];
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
            onSubmit={(e) => {
              e.preventDefault();
              submitCapture();
            }}
          >
            <h2 id="capture-title">{captureType === "note" ? "Add note" : "Quick Capture"}</h2>
            {activeWorkspaceId === "all" && !captureProjectId && (
              <label className="captureWorkspace">
                Workspace
                <select
                  value={writeWorkspaceId}
                  onChange={(event) => selectWriteWorkspace(event.target.value)}
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.workspaceId}>
                      {workspace.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <input
              autoFocus
              aria-label={captureType === "note" ? "Note title" : "Task title"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                captureType === "note" ? "Note title" : "What needs to be done?"
              }
            />
            {captureType === "task" && (
              <>
                <p>Try “Zavolat Petrovi zítra” or “Servis 25.9. #high”</p>
                {draft.trim() && (
                  <div className="capturePreview">
                    <strong>{parseCapture(draft).title || "Untitled task"}</strong>
                    <span>
                      {parseCapture(draft).when || "Inbox"}
                      {parseCapture(draft).priority !== "none" ? ` · ${parseCapture(draft).priority}` : ""}
                    </span>
                  </div>
                )}
              </>
            )}
            <div>
              <button type="button" onClick={() => setCapture(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className="ai"
                disabled={!draft.trim()}
              >
                {captureType === "note" ? "Add note" : "Add task"}
              </button>
            </div>
          </form>
        </div>
      )}
      {selected && (
        <div className="backdrop" onClick={closeDetail}>
          <aside className="detail" onClick={(e) => e.stopPropagation()}>
            <button
              className="close"
              onClick={closeDetail}
            >
              ×
            </button>
            <p className="eyebrow">{selected.type}</p>
            <input
              className="titleEdit"
              value={selected.title}
              onChange={(e) =>
                setSelected({ ...selected, title: e.target.value })
              }
              onBlur={(e) => rename(selected, e.target.value)}
            />
            {context && (
              <div className="contextStrip">
                <b>Context</b>
                <span>
                  {context.summary.tasks} tasks · {context.summary.notes} notes
                  · {context.summary.projects} projects ·{" "}
                  {context.summary.areas} areas
                </span>
                <small>
                  {context.related
                    .slice(0, 6)
                    .map((x) => x.title)
                    .join(" · ") || "No related entities"}
                </small>
              </div>
            )}
            {selected.type === "area" && (
              <div className="projectDetail">
                <h3>PROJECTS</h3>
                {projects
                  .filter((p) =>
                    sources(selected.id, "belongs_to_area").includes(p.id),
                  )
                  .map((p) => (
                    <article key={p.id} onClick={() => inspect(p)}>
                      <div className="entityIcon">◆</div>
                      <div>
                        <strong>{p.title}</strong>
                        <small>project</small>
                      </div>
                    </article>
                  ))}
                <h3>TASKS</h3>
                {tasks
                  .filter(
                    (t) =>
                      t.status === "open" &&
                      sources(selected.id, "belongs_to_area").includes(t.id),
                  )
                  .map((t) => (
                    <article key={t.id} onClick={() => inspect(t)}>
                      <button
                        className="check"
                        onClick={(e) => {
                          e.stopPropagation();
                          done(t.id);
                        }}
                      >
                        ○
                      </button>
                      <strong>{t.title}</strong>
                    </article>
                  ))}
              </div>
            )}
            {selected.type === "project" && (
              <div className="projectDetail">
                <label>
                  Area
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_area")[0] || "",
                    )}
                    onChange={async (e) => {
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_area",
                      );
                    }}
                  >
                    <option value="">None</option>
                    {areas.filter((area) => area.workspaceId === selected.workspaceId).map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                </label>
                <h3>OPEN TASKS</h3>
                {tasks
                  .filter(
                    (t) =>
                      t.status === "open" &&
                      sources(selected.id, "belongs_to_project").includes(t.id),
                  )
                  .map((t) => (
                    <article key={t.id}>
                      <button className="check" onClick={() => done(t.id)}>
                        ○
                      </button>
                      <strong>{t.title}</strong>
                    </article>
                  ))}
                <button
                  onClick={() => {
                    openCapture("task", selected.id);
                  }}
                >
                  ＋ Add task
                </button>
                <h3>NOTES</h3>
                {scopedItems
                  .filter(
                    (n) =>
                      n.type === "note" &&
                      sources(selected.id, "belongs_to_project").includes(n.id),
                  )
                  .map((n) => (
                    <article key={n.id}>
                      <div>
                        <strong>{n.title}</strong>
                        <p>{n.content}</p>
                      </div>
                    </article>
                  ))}
                <button
                  onClick={() => {
                    openCapture("note", selected.id);
                  }}
                >
                  ＋ Add note
                </button>
              </div>
            )}
            {selected.type === "note" && (
              <div className="fields">
                <label>
                  Project
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_project")[0] || "",
                    )}
                    onChange={async (e) => {
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_project",
                      );
                    }}
                  >
                    <option value="">None</option>
                    {projects.filter((project) => project.workspaceId === selected.workspaceId).map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {selected.type === "task" && (
              <div className="fields">
                <label>
                  List
                  <select
                    value={
                      selected.properties.inbox === true
                        ? "Inbox"
                        : selected.properties.someday === true
                          ? "Someday"
                        : selected.properties.today === true ||
                            (typeof selected.properties.when === "string" && selected.properties.when <= today)
                            ? "Today"
                            : "Anytime"
                    }
                    onChange={(event) => {
                      const destination = event.target.value;
                      patch(selected, {
                        inbox: destination === "Inbox",
                        someday: destination === "Someday",
                        today: destination === "Today",
                        when: destination === "Today" ? today : "",
                      }, `moved to ${destination}`);
                    }}
                  >
                    <option>Inbox</option>
                    <option>Today</option>
                    <option>Anytime</option>
                    <option>Someday</option>
                  </select>
                </label>
                <label>
                  When
                  <input
                    type="date"
                    value={String(selected.properties.when || "")}
                    onChange={(e) =>
                      patch(selected, {
                        when: e.target.value,
                        today: e.target.value === today,
                        inbox: false,
                        someday: false,
                      })
                    }
                  />
                </label>
                <label>
                  Deadline
                  <input
                    type="date"
                    value={String(selected.properties.deadline || "")}
                    onChange={(e) =>
                      patch(selected, { deadline: e.target.value })
                    }
                  />
                </label>
                <label>
                  Project
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_project")[0] || "",
                    )}
                    onChange={async (e) => {
                      await patch(selected, { inbox: false });
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_project",
                      );
                    }}
                  >
                    <option value="">None</option>
                    {projects.filter((project) => project.workspaceId === selected.workspaceId).map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Area
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_area")[0] || "",
                    )}
                    onChange={async (e) => {
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_area",
                      );
                    }}
                  >
                    <option value="">None</option>
                    {areas.filter((area) => area.workspaceId === selected.workspaceId).map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Priority
                  <select
                    value={String(selected.properties.priority || "none")}
                    onChange={(e) =>
                      patch(selected, { priority: e.target.value })
                    }
                  >
                    <option value="none">None</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label>
                  Reminder
                  <input
                    type="datetime-local"
                    value={toLocalDateTime(selected.properties.reminderAt)}
                    onChange={(e) =>
                      patch(selected, { reminderAt: fromLocalDateTime(e.target.value) }, "reminder changed")
                    }
                  />
                </label>
                {selected.properties.when && notificationState && (
                  <button
                    type="button"
                    onClick={() => {
                      const planned = new Date(`${String(selected.properties.when)}T12:00:00Z`);
                      const workdays = notificationState.preferences.workdays;
                      while (workdays.length && !workdays.includes(planned.getUTCDay())) {
                        planned.setUTCDate(planned.getUTCDate() + 1);
                      }
                      const date = planned.toISOString().slice(0, 10);
                      patch(selected, {
                        reminderAt: zonedDateTimeToIso(
                          date,
                          notificationState.preferences.workdayStart,
                          notificationState.preferences.timezone,
                        ),
                      }, "workday reminder set");
                    }}
                  >
                    Remind at next workday start
                  </button>
                )}
                <label>
                  Task notes
                  <textarea
                    value={String(selected.properties.notes || "")}
                    onChange={(e) => patch(selected, { notes: e.target.value })}
                    placeholder="Notes…"
                  />
                </label>
                <div className="checklistField">
                  <span>Checklist</span>
                  {(Array.isArray(selected.properties.checklist)
                    ? selected.properties.checklist
                    : []
                  ).map((raw, index, all) => {
                    const item = typeof raw === "string"
                      ? { id: `${index}`, title: raw, done: false }
                      : raw as { id?: string; title?: string; done?: boolean };
                    return (
                      <label className="checklistItem" key={item.id || index}>
                        <input
                          type="checkbox"
                          checked={Boolean(item.done)}
                          onChange={() => patch(selected, {
                            checklist: all.map((entry, entryIndex) => {
                              const normalized = typeof entry === "string"
                                ? { id: `${entryIndex}`, title: entry, done: false }
                                : entry as { id?: string; title?: string; done?: boolean };
                              return entryIndex === index
                                ? { ...normalized, done: !normalized.done }
                                : normalized;
                            }),
                          }, "checklist updated")}
                        />
                        <span className={item.done ? "checked" : ""}>{item.title}</span>
                      </label>
                    );
                  })}
                  <div className="checklistAdd">
                    <input
                      value={checklistDraft}
                      onChange={(event) => setChecklistDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || !checklistDraft.trim()) return;
                        event.preventDefault();
                        const existing = Array.isArray(selected.properties.checklist)
                          ? selected.properties.checklist
                          : [];
                        patch(selected, {
                          checklist: [...existing, { id: crypto.randomUUID(), title: checklistDraft.trim(), done: false }],
                        }, "checklist item added");
                        setChecklistDraft("");
                      }}
                      placeholder="Add checklist item"
                    />
                    <button
                      type="button"
                      disabled={!checklistDraft.trim()}
                      onClick={() => {
                        const existing = Array.isArray(selected.properties.checklist)
                          ? selected.properties.checklist
                          : [];
                        patch(selected, {
                          checklist: [...existing, { id: crypto.randomUUID(), title: checklistDraft.trim(), done: false }],
                        }, "checklist item added");
                        setChecklistDraft("");
                      }}
                    >Add</button>
                  </div>
                </div>
                <label>
                  Repeat
                  <select
                    value={String(
                      (selected.properties.recurrence as any)?.frequency ||
                        selected.properties.repeat ||
                        "",
                    )}
                    onChange={(e) =>
                      patch(selected, {
                        recurrence: e.target.value
                          ? {
                              frequency: e.target.value,
                              interval: 1,
                              mode: "scheduled",
                            }
                          : null,
                        repeat: null,
                      })
                    }
                  >
                    <option value="">Never</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </label>
                {(selected.properties.recurrence as any)?.frequency && (
                  <>
                    <label>
                      Every
                      <input
                        type="number"
                        min="1"
                        value={String(
                          (selected.properties.recurrence as any)?.interval ||
                            1,
                        )}
                        onChange={(e) =>
                          patch(selected, {
                            recurrence: {
                              ...(selected.properties.recurrence as any),
                              interval: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      Repeat from
                      <select
                        value={String(
                          (selected.properties.recurrence as any)?.mode ||
                            "scheduled",
                        )}
                        onChange={(e) =>
                          patch(selected, {
                            recurrence: {
                              ...(selected.properties.recurrence as any),
                              mode: e.target.value,
                            },
                          })
                        }
                      >
                        <option value="scheduled">Scheduled date</option>
                        <option value="completion">Completion date</option>
                      </select>
                    </label>
                  </>
                )}
                {Array.isArray(selected.properties.activity) && selected.properties.activity.length > 0 && (
                  <div className="activityLog">
                    <h3>HISTORY</h3>
                    {[...selected.properties.activity]
                      .reverse()
                      .slice(0, 12)
                      .map((entry: any, index) => (
                        <div key={`${entry.at}-${index}`}>
                          <span>{String(entry.action || "updated")}</span>
                          <time>{new Date(Number(entry.at)).toLocaleString()}</time>
                        </div>
                      ))}
                  </div>
                )}
                <button
                  onClick={() =>
                    patch(selected, {
                      someday: true,
                      today: false,
                      when: "",
                      inbox: false,
                    })
                  }
                >
                  Move to Someday
                </button>
                {selected.status === "completed" ? (
                  <button onClick={() => reopenTask(selected)}>Reopen</button>
                ) : (
                  <button onClick={() => done(selected.id)}>Complete</button>
                )}
                <button className="danger" onClick={() => remove(selected)}>
                  Delete
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
      {assistantOpen && (
        <div className="assistantPanel">
          <div className="assistantHead">
            <b>Assistant</b>
            <button onClick={() => setAssistantOpen(false)}>×</button>
          </div>
          <div className="assistantContext">
            {context
              ? `${workspaceName} · Context: ${context.focus.title}`
              : `${workspaceName} · server-verified workspace context`}
          </div>
          <div className="assistantMessages">
            {messages.length === 0 && (
              <div className="assistantWelcome">
                <p>Ask about your tasks or safely propose a change.</p>
                <button onClick={() => askAI("Co dnes hoří?")} disabled={aiBusy}>
                  Today’s brief
                </button>
                <small>Writes always require confirmation.</small>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={"assistantTurn " + m.role}>
                <div className={"msg " + m.role}>{m.content}</div>
                {m.proposal && (
                  <div className={`aiProposal ${m.resolved ? "resolved" : ""}`}>
                    <strong>{m.proposal.summary}</strong>
                    <dl>
                      {m.proposal.changes.map((change) => (
                        <div key={`${change.label}:${change.value}`}>
                          <dt>{change.label}</dt>
                          <dd>{change.value}</dd>
                        </div>
                      ))}
                    </dl>
                    {!m.resolved && (
                      <div className="aiProposalActions">
                        <button
                          className="primaryAction"
                          disabled={aiBusy}
                          onClick={() => resolveAIProposal(m.proposal!.id, "confirm")}
                        >
                          Confirm
                        </button>
                        <button
                          disabled={aiBusy}
                          onClick={() => resolveAIProposal(m.proposal!.id, "cancel")}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {m.actionId && !m.resolved && (
                  <button className="aiUndo" disabled={aiBusy} onClick={() => undoAIAction(m.actionId!)}>
                    Undo AI change
                  </button>
                )}
              </div>
            ))}
            {aiBusy && <p className="assistantThinking">Working…</p>}
          </div>
          <div className="assistantComposer">
            <input
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") askAI();
              }}
              placeholder="Ask AI…"
              disabled={aiBusy}
            />
            <button onClick={() => askAI()} disabled={aiBusy || !aiText.trim()}>Send</button>
          </div>
        </div>
      )}
      {undo && (
        <div className="undo">
          Item changed <button onClick={restore}>Undo</button>
        </div>
      )}
    </main>
  );
}
