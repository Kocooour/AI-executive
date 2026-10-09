"use client";
import { useEffect, useRef, useState } from "react";
import type { Entity } from "../../../lib/db";
import type { AttentionResponse } from "../types";
import { localizeServerError } from "../../../lib/server-errors";
import { cachedAttention, saveAttention } from "../../../lib/attention-cache";

// The "Needs attention" list on Home: loading and refreshing the server's evaluation, keeping the
// last one while the connection is lost (marked out of date), and snooze/dismiss. Moved verbatim
// from use-lumi-app.tsx; the values it needs from the rest of the app are passed in.
export function useAttention({ authState, activeWorkspaceId, syncStatus, items, pendingDeletedIds, tr, language, signingOut }: {
  tr: (key: string) => string;
  language: string;
  authState: string;
  activeWorkspaceId: string;
  syncStatus: string;
  items: Entity[];
  pendingDeletedIds: () => string[];
  // True from the moment sign-out removes the local copy: an answer arriving later is not kept.
  signingOut: () => boolean;
}) {
  const [attention, setAttention] = useState<AttentionResponse | null>(null),
    [attentionError, setAttentionError] = useState(""),
    [attentionReload, setAttentionReload] = useState(0),
    [attentionOutdated, setAttentionOutdated] = useState(false),
    // Shown from this browser's copy until the server has evaluated again (not yet known to be
    // out of date, but snooze and dismiss wait for a fresh evaluation).
    [attentionFromCache, setAttentionFromCache] = useState(false),
    [attentionBusyKey, setAttentionBusyKey] = useState(""),
    [showAllAttention, setShowAllAttention] = useState(false);
  const attentionLoadVersion = useRef(0);

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
      throw new Error(localizeServerError(data.error, tr) || tr("attentionUnavailable"));
    }
    if (current()) {
      setAttention(data as AttentionResponse);
      setAttentionFromCache(false);
      if (!signingOut()) {
        try { saveAttention(localStorage, data as AttentionResponse); } catch { /* storage unavailable */ }
      }
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
      if (!response.ok) throw new Error(localizeServerError(result.error, tr) || tr("attentionActionFailed"));
      await loadAttention(activeWorkspaceId);
    } catch (error) {
      await loadAttention(activeWorkspaceId).catch(() => undefined);
      setAttentionError(error instanceof Error ? error.message : tr("attentionActionFailed"));
    } finally {
      setAttentionBusyKey("");
    }
  }

  const shownAttention = attention?.workspaceId === activeWorkspaceId ? attention : null;
  // A copy from this browser is marked too, until the server has evaluated again.
  const attentionStale = Boolean(shownAttention) && (attentionOutdated || attentionFromCache);
  // Snooze and dismiss need the server to hold the same data as this device.
  const attentionActionsBlocked = attentionOutdated || attentionFromCache || syncStatus !== "synced";
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
  // The last evaluation survives a lost connection so Home can show it as stale, also after the app
  // was closed: it is kept in this browser per workspace (lib/attention-cache.ts) and shown as out
  // of date until the server evaluates again. Signing out removes it.
  useEffect(() => {
    attentionLoadVersion.current += 1;
    let kept: AttentionResponse | null = null;
    try { kept = authState === "ready" ? cachedAttention<AttentionResponse>(localStorage, activeWorkspaceId) : null; } catch { kept = null; }
    setAttention(kept);
    setAttentionFromCache(Boolean(kept));
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
    const refresh = () => loadAttention(workspaceId).catch((error) => { if (!cancelled) setAttentionError(error instanceof Error ? error.message : tr("attentionUnavailable")); });
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    return () => { cancelled = true; attentionLoadVersion.current += 1; window.clearInterval(timer); };
  }, [authState, activeWorkspaceId, syncStatus, attentionReload]);
  // An error shown in one language is not kept after the language changes; evaluating again
  // reports a failure that still lasts in the new language.
  const errorLanguage = useRef(language);
  useEffect(() => {
    if (errorLanguage.current === language) return;
    errorLanguage.current = language;
    if (!attentionError) return;
    setAttentionError("");
    setAttentionReload((count) => count + 1);
  }, [language]);

  return {
    actOnAttention,
    attentionActionsBlocked,
    attentionBusyKey,
    attentionError,
    attentionFromCache,
    attentionOutdated,
    attentionStale,
    loadAttention,
    setAttentionError,
    setShowAllAttention,
    showAllAttention,
    visibleAttention,
  };
}
