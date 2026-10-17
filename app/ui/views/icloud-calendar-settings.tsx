"use client";
import { useEffect, useRef, useState } from "react";
import type { LumiApp } from "../use-lumi-app";
import { localizeServerError } from "../../../lib/server-errors";
import { pluralText } from "../../../lib/plural";

// Settings → Calendars → iCloud (read-only CalDAV). The Apple ID and the app-specific password live only in this
// component's state while a form is open: they are never written to local storage, IndexedDB or a draft, and the password
// is cleared as soon as it has been sent. The server answers with a masked Apple ID, states and opaque calendar ids only.

interface CalendarChoice { id: string; name: string; color: string | null; selected: boolean; workspaceId: string | null }
interface ConnectedCalendar { id: string; sourceId: string; label: string; workspaceId: string; status: string; eventCount: number; lastSuccessAt: number | null; lastError: string }
interface AccountState {
  label: string;
  status: "ready" | "pending" | "stale" | "syncing" | "error" | "auth_failed";
  lastSuccessAt: number | null;
  lastError: string;
  calendars: ConnectedCalendar[];
}
type Mode = "idle" | "choose" | "password" | "edit";

export function ICloudCalendarSettings({ app }: { app: LumiApp }) {
  const { tr, language, workspaces, askConfirm, activeWorkspaceId, writeWorkspaceId, loadCalendar, loadDayPlan, calendarToday } = app;
  const [account, setAccount] = useState<AccountState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");
  const [appleId, setAppleId] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [choices, setChoices] = useState<CalendarChoice[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  // The action that is running, as its status text key; empty when idle.
  const [busyKey, setBusyKey] = useState("");
  const busy = busyKey !== "";
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const locale = language === "cs" ? "cs-CZ" : "en-GB";
  const viewWorkspace = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
  const workspaceName = (id: string) => workspaces.find((workspace) => workspace.workspaceId === id)?.title || id;
  const defaultWorkspace = workspaces.some((workspace) => workspace.workspaceId === "personal") ? "personal" : workspaces[0]?.workspaceId || "personal";

  async function load() {
    const response = await fetch("/api/calendar/icloud", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("icloudUnavailable"));
    if (mounted.current) { setAccount(data.account ?? null); setLoaded(true); }
  }
  useEffect(() => { load().catch(() => { if (mounted.current) { setLoaded(true); setStatus(tr("icloudUnavailable")); setFailed(true); } }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function post(body: Record<string, unknown>) {
    const response = await fetch("/api/calendar/icloud", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if ("account" in data && mounted.current) {
      setAccount(data.account ?? null);
      // An answer that carries the account (also with an error, e.g. the first read failed after connecting) means the
      // connection exists: the form is left for the connected view, where Refresh, Edit and Disconnect are, and the error is
      // shown there. The typed credentials are dropped.
      if (data.account) { setMode("idle"); setChoices([]); setSelection({}); setAppPassword(""); setAppleId(""); }
      if (data.account && !response.ok) void reloadViews().catch(() => undefined);
    }
    if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("icloudActionFailed"));
    return data;
  }

  async function run(statusKey: string, action: () => Promise<string | void>) {
    if (busy) return;
    setBusyKey(statusKey);
    setStatus("");
    setFailed(false);
    try {
      const message = await action();
      if (message && mounted.current) setStatus(message);
    } catch (error) {
      if (mounted.current) { setStatus(error instanceof Error ? error.message : tr("icloudActionFailed")); setFailed(true); }
    } finally {
      if (mounted.current) setBusyKey("");
    }
  }

  // The Calendar, Today and the day plan read the event cache; they are reloaded after every change of the connection.
  async function reloadViews() {
    await loadCalendar(viewWorkspace).catch(() => undefined);
    await loadDayPlan(viewWorkspace, calendarToday);
  }

  // A new connection starts with every calendar chosen; editing starts from the current selection.
  function applyChoices(list: CalendarChoice[], editing: boolean) {
    setChoices(list);
    setSelection(Object.fromEntries(list.filter((item) => !editing || item.selected).map((item) => [item.id, item.workspaceId || defaultWorkspace])));
  }

  const chosen = () => Object.entries(selection).map(([id, workspaceId]) => ({ id, workspaceId }));
  const clearSecrets = () => { setAppPassword(""); };
  const cancel = () => { setMode("idle"); setChoices([]); setSelection({}); clearSecrets(); setStatus(""); setFailed(false); };

  const discover = () => run("icloudFinding", async () => {
    const data = await post({ action: "discover", appleId, appPassword });
    applyChoices(Array.isArray(data.calendars) ? data.calendars : [], false);
    setMode("choose");
  });

  const connect = () => run("icloudConnecting", async () => {
    try {
      await post({ action: "connect", appleId, appPassword, calendars: chosen() });
    } finally {
      clearSecrets();
    }
    setMode("idle"); setChoices([]); setSelection({}); setAppleId("");
    await reloadViews();
    return tr("icloudConnected");
  });

  const savePassword = () => run("icloudSavingPassword", async () => {
    try { await post({ action: "update-password", appPassword }); } finally { clearSecrets(); }
    setMode("idle");
    await reloadViews();
    return tr("icloudPasswordSaved");
  });

  const editCalendars = () => run("icloudLoadingCalendars", async () => {
    const data = await post({ action: "calendars" });
    applyChoices(Array.isArray(data.calendars) ? data.calendars : [], true);
    setMode("edit");
  });

  const saveCalendars = () => run("icloudSavingSelection", async () => {
    await post({ action: "select", calendars: chosen() });
    setMode("idle"); setChoices([]); setSelection({});
    await reloadViews();
    return tr("icloudCalendarsSaved");
  });

  const refresh = () => run("icloudRefreshing", async () => {
    await post({ action: "refresh" });
    await reloadViews();
    return tr("icloudRefreshed");
  });

  const disconnect = async () => {
    if (!account) return;
    const confirmed = await askConfirm({ title: tr("icloudDisconnectTitle"), message: tr("icloudDisconnectConfirm").replace("{label}", () => account.label), confirmLabel: tr("disconnect"), danger: true });
    if (!confirmed) return;
    await run("icloudDisconnecting", async () => {
      await post({ action: "disconnect" });
      setAccount(null); setMode("idle");
      await reloadViews();
      return tr("icloudDisconnected");
    });
  };

  const statusText = (state: AccountState) => {
    if (state.status === "auth_failed") return tr("icloudAuthFailed");
    if (state.status === "syncing") return tr("icloudSyncing");
    if (state.status === "error") return `${tr("icloudError")}${state.lastError ? ` · ${localizeServerError(state.lastError, tr)}` : ""}`;
    if (state.status === "pending" || !state.lastSuccessAt) return tr("icloudPending");
    const synced = tr("icloudSynced").replace("{time}", () => new Date(state.lastSuccessAt!).toLocaleString(locale));
    return state.status === "stale" ? `${tr("icloudStale")} · ${synced}` : synced;
  };

  const choiceList = (
    <fieldset className="icloudChoices" disabled={busy}>
      <legend>{tr("icloudChoose")}</legend>
      {choices.length === 0 && <p>{tr("icloudNoCalendars")}</p>}
      {choices.map((choice) => {
        const checked = choice.id in selection;
        return (
          <div className="icloudChoice" key={choice.id}>
            <label className="icloudCheck">
              <input type="checkbox" checked={checked} onChange={(event) => setSelection((current) => {
                const next = { ...current };
                if (event.target.checked) next[choice.id] = choice.workspaceId || defaultWorkspace;
                else delete next[choice.id];
                return next;
              })} />
              {choice.color && <span className="icloudColor" style={{ background: choice.color }} aria-hidden="true" />}
              <span>{choice.name}</span>
            </label>
            <label className="icloudWorkspace">
              <select aria-label={tr("icloudWorkspaceFor").replace("{name}", () => choice.name)} value={selection[choice.id] || choice.workspaceId || defaultWorkspace} disabled={!checked}
                onChange={(event) => setSelection((current) => ({ ...current, [choice.id]: event.target.value }))}>
                {workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>)}
              </select>
            </label>
          </div>
        );
      })}
    </fieldset>
  );

  return (
    <div className="icloudCalendar" aria-busy={busy}>
      <div className="sectionHeading">
        <div>
          <h2>{tr("icloudTitle")}</h2>
          <p>{tr("icloudInfo")}</p>
        </div>
        <span className={`installStatus ${account && account.status !== "auth_failed" ? "installed" : ""}`}>{account ? tr("readOnly") : tr("notConnected")}</span>
      </div>
      {loaded && !account && (
        <div className="icloudForm">
          <p className="settingsHint">
            {tr("icloudHowTo")}{" "}
            <a href="https://appleid.apple.com/account/manage" target="_blank" rel="noopener noreferrer">{tr("icloudOpenAppleAccount")}</a>
          </p>
          <label>
            {tr("icloudAppleId")}
            <input type="email" name="lumi-icloud-apple-id" autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="email" maxLength={254}
              value={appleId} disabled={busy || mode === "choose"} onChange={(event) => setAppleId(event.target.value)} />
          </label>
          <label>
            {tr("icloudAppPassword")}
            <input type="password" name="lumi-icloud-app-password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={40}
              placeholder="xxxx-xxxx-xxxx-xxxx" value={appPassword} disabled={busy || mode === "choose"} onChange={(event) => setAppPassword(event.target.value)} />
          </label>
          {mode === "choose" ? (
            <>
              {choiceList}
              <div className="notificationActions">
                <button className="primaryAction" disabled={busy || chosen().length === 0} onClick={connect}>{tr("icloudConnect")}</button>
                <button disabled={busy} onClick={cancel}>{tr("icloudCancel")}</button>
              </div>
            </>
          ) : (
            <div className="notificationActions">
              <button className="primaryAction" disabled={busy || !appleId.trim() || !appPassword.trim()} onClick={discover}>{busy ? tr("icloudFinding") : tr("icloudFind")}</button>
            </div>
          )}
        </div>
      )}
      {account && (
        <div className="icloudAccount">
          <p className="icloudAccountLine">
            <strong>{tr("icloudAccount")}: {account.label}</strong>
            <span className={account.status === "auth_failed" || account.status === "error" ? "icloudProblem" : undefined}>{statusText(account)}</span>
          </p>
          <div className="calendarSources">
            {account.calendars.map((calendar) => (
              <div key={calendar.sourceId}>
                <span>
                  <strong>{calendar.label}</strong>
                  <small>
                    {workspaceName(calendar.workspaceId)} · {calendar.status === "ready" ? pluralText(language, calendar.eventCount, tr("pluEvents")) : calendar.status === "error" ? tr("syncFailed") : tr("icloudPending")}
                  </small>
                  {calendar.lastError && account.status !== "auth_failed" && <small>{localizeServerError(calendar.lastError, tr)}</small>}
                </span>
              </div>
            ))}
          </div>
          {mode === "password" && (
            <div className="icloudForm">
              <p className="settingsHint">
                {tr("icloudHowTo")}{" "}
                <a href="https://appleid.apple.com/account/manage" target="_blank" rel="noopener noreferrer">{tr("icloudOpenAppleAccount")}</a>
              </p>
              <label>
                {tr("icloudNewPassword")}
                <input type="password" name="lumi-icloud-app-password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={40}
                  placeholder="xxxx-xxxx-xxxx-xxxx" value={appPassword} disabled={busy} onChange={(event) => setAppPassword(event.target.value)} />
              </label>
              <div className="notificationActions">
                <button className="primaryAction" disabled={busy || !appPassword.trim()} onClick={savePassword}>{tr("icloudSavePassword")}</button>
                <button disabled={busy} onClick={cancel}>{tr("icloudCancel")}</button>
              </div>
            </div>
          )}
          {mode === "edit" && (
            <div className="icloudForm">
              {choiceList}
              <div className="notificationActions">
                <button className="primaryAction" disabled={busy || chosen().length === 0} onClick={saveCalendars}>{tr("icloudSaveCalendars")}</button>
                <button disabled={busy} onClick={cancel}>{tr("icloudCancel")}</button>
              </div>
            </div>
          )}
          {mode === "idle" && (
            <div className="notificationActions">
              {account.status === "auth_failed"
                ? <button className="primaryAction" disabled={busy} onClick={() => { setMode("password"); setStatus(""); }}>{tr("icloudChangePassword")}</button>
                : <>
                  <button disabled={busy} onClick={refresh}>{tr("refresh")}</button>
                  <button disabled={busy} onClick={() => { setMode("password"); setStatus(""); }}>{tr("icloudChangePassword")}</button>
                  <button disabled={busy} onClick={editCalendars}>{tr("icloudEditCalendars")}</button>
                </>}
              <button disabled={busy} onClick={disconnect}>{tr("disconnect")}</button>
            </div>
          )}
        </div>
      )}
      {busy && <p role="status">{tr(busyKey)}</p>}
      {!busy && status && <p role={failed ? "alert" : "status"} className={failed ? "icloudProblem" : undefined}>{status}</p>}
    </div>
  );
}
