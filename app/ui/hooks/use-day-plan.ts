"use client";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import type { Entity } from "../../../lib/db";
import type { AIProposal, ConfirmRequest, DayPlan, DayPlanItem, WorkSession } from "../types";
import { localizeServerError } from "../../../lib/server-errors";

// Today's plan and the running work session: loading and refreshing the day plan, accepting or
// moving its blocks (approval-bound actions with Undo), and starting, pausing and finishing work on
// a task. Moved verbatim from use-lumi-app.tsx; the values it needs from the rest of the app are
// passed in.
export function useDayPlan({ authState, activeWorkspaceId, writeWorkspaceId, items, language, tr, calendarToday,
  calendarWorkspaceSelection, askConfirm, closeDetail, pullFromServer, selectWorkspace, syncQueue, pendingKey }: {
  authState: string;
  activeWorkspaceId: string;
  writeWorkspaceId: string;
  items: Entity[];
  language: string;
  tr: (key: string) => string;
  calendarToday: string;
  calendarWorkspaceSelection: MutableRefObject<string>;
  askConfirm: (request: ConfirmRequest) => Promise<boolean>;
  closeDetail: () => void;
  pullFromServer: () => Promise<void>;
  selectWorkspace: (workspaceId: string) => void;
  syncQueue: MutableRefObject<Promise<unknown>>;
  pendingKey: string;
}) {
  const [dayPlanNow, setDayPlanNow] = useState(() => Date.now()),
    [dayPlan, setDayPlan] = useState<DayPlan | null>(null),
    [dayPlanStatus, setDayPlanStatus] = useState(""),
    [dayPlanBusy, setDayPlanBusy] = useState(false),
    [dayPlanUndo, setDayPlanUndo] = useState<{ actionId: string; workspaceId: string; date: string } | null>(null),
    [workSession, setWorkSession] = useState<WorkSession | null>(null),
    [workSessionBusy, setWorkSessionBusy] = useState(false),
    [workSessionStatus, setWorkSessionStatus] = useState(""),
    [workSessionNow, setWorkSessionNow] = useState(() => Date.now()),
    [workSessionLoadedAt, setWorkSessionLoadedAt] = useState(() => Date.now());
  const dayPlanLoadVersion = useRef(0);
  const workSessionLoadVersion = useRef(0);

  // Why a task is in the day plan: `dayPlanReason_<reason>` in the dictionary; an unknown reason is
  // shown as it is.
  const dayPlanWhy = (reason: string) => {
    if (reason.startsWith("duration:")) return tr("dayPlanReasonDuration").replace("{minutes}", () => reason.slice(9));
    const key = `dayPlanReason_${reason}`;
    const label = tr(key);
    return label === key ? reason : label;
  };

  async function loadDayPlan(workspaceId: string, date: string) {
    const version = ++dayPlanLoadVersion.current;
    const response = await fetch(`/api/day-plan?workspaceId=${encodeURIComponent(workspaceId)}&date=${date}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("dayPlanUnavailable"));
    if (version === dayPlanLoadVersion.current && calendarWorkspaceSelection.current === workspaceId) setDayPlan(data as DayPlan);
    return data as DayPlan;
  }

  async function loadWorkSession(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const version = ++workSessionLoadVersion.current;
    const response = await fetch(`/api/work-sessions?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("workSessionUnavailable"));
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
        throw new Error(localizeServerError(data.error, tr) || tr("workSessionFailed"));
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
    } catch (error) { setWorkSessionStatus(error instanceof Error ? error.message : tr("workSessionFailed")); }
    finally { setWorkSessionBusy(false); }
  }

  const visibleDayPlan = dayPlan?.workspaceId === (activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) && dayPlan.date === calendarToday ? dayPlan : null;
  const dayPlanTimeline = visibleDayPlan ? [...visibleDayPlan.existingBlocks.map((item) => ({ ...item, existing: true })),
    ...visibleDayPlan.planBlocks.map((item) => ({ ...item, existing: false }))].sort((a, b) => String(a.start).localeCompare(String(b.start))) : [];
  const currentDayPlanBlock = dayPlanTimeline.find((item) => Date.parse(item.start || "") <= dayPlanNow && dayPlanNow < Date.parse(item.end || ""));
  const nextDayPlanBlock = dayPlanTimeline.find((item) => Date.parse(item.start || "") > dayPlanNow);
  const workElapsedMs = workSession ? workSession.elapsedMs + (workSession.state === "running" ? Math.max(0, workSessionNow - workSessionLoadedAt) : 0) : 0;
  const workElapsedText = `${String(Math.floor(workElapsedMs / 3_600_000)).padStart(2, "0")}:${String(Math.floor(workElapsedMs / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(workElapsedMs / 1000) % 60).padStart(2, "0")}`;
  const workOverrun = Boolean(workSession?.estimatedMinutes && workElapsedMs > workSession.estimatedMinutes * 60_000);
  useEffect(() => {
    if (authState !== "ready") return;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setDayPlan(null);
    setDayPlanStatus("");
    loadDayPlan(workspaceId, calendarToday)
      .catch(() => { if (calendarWorkspaceSelection.current === workspaceId) setDayPlanStatus(tr("theDayPlanIs")); });
    // A language change loads again, so a failure that still lasts is reported in the new language.
  }, [authState, activeWorkspaceId, writeWorkspaceId, calendarToday, items, language]);
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
    setWorkSessionStatus("");
    loadWorkSession(workspaceId).catch((error) => setWorkSessionStatus(error instanceof Error ? error.message : tr("workSessionUnavailable")));
    const refresh = () => { if (document.visibilityState === "visible") loadWorkSession(workspaceId).catch(() => undefined); };
    const poll = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { workSessionLoadVersion.current += 1; window.clearInterval(poll); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [authState, activeWorkspaceId, writeWorkspaceId, language]);
  useEffect(() => {
    if (workSession?.state !== "running") return;
    const timer = window.setInterval(() => setWorkSessionNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [workSession?.id, workSession?.state]);
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
      if (!proposeResponse.ok) throw new Error(localizeServerError(proposed.error, tr) || tr("dayPlanChanged"));
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
      if (!confirmResponse.ok) throw new Error(localizeServerError(confirmed.error, tr) || tr("dayPlanChanged"));
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
      if (!response.ok) throw new Error(localizeServerError(result.error, tr) || tr("dayPlanChanged"));
      setDayPlanUndo(null);
      await pullFromServer();
      await loadDayPlan(dayPlanUndo.workspaceId, dayPlanUndo.date);
    } catch (error) { setDayPlanStatus(error instanceof Error ? error.message : tr("dayPlanChanged")); }
    finally { setDayPlanBusy(false); }
  }

  return {
    dayPlanNow,
    setDayPlanNow,
    dayPlan,
    setDayPlan,
    dayPlanStatus,
    setDayPlanStatus,
    dayPlanBusy,
    setDayPlanBusy,
    dayPlanUndo,
    setDayPlanUndo,
    workSession,
    setWorkSession,
    workSessionBusy,
    setWorkSessionBusy,
    workSessionStatus,
    setWorkSessionStatus,
    workSessionNow,
    setWorkSessionNow,
    workSessionLoadedAt,
    setWorkSessionLoadedAt,
    dayPlanWhy,
    loadDayPlan,
    loadWorkSession,
    workSessionAction,
    visibleDayPlan,
    dayPlanTimeline,
    currentDayPlanBlock,
    nextDayPlanBlock,
    workElapsedMs,
    workElapsedText,
    workOverrun,
    applyDayPlanAction,
    undoDayPlanBlock,
  };
}
