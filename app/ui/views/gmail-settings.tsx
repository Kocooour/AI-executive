"use client";

import { useEffect, useState } from "react";
import type { LumiApp } from "../use-lumi-app";

type Account = { id: string; email: string; workspaceId: string };
type Message = { id: string; subject: string; from: string; to: string; date: string; snippet: string; unread: boolean };
type Folder = "inbox" | "sent";

export function GmailSettings({ app }: { app: LumiApp }) {
  const { language, tr } = app;
  const workspaceId = app.activeWorkspaceId === "all" ? "" : app.activeWorkspaceId;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState("");
  const [folder, setFolder] = useState<Folder>("inbox");
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  async function json(url: string, body?: Record<string, unknown>) {
    const response = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), cache: "no-store" } : { cache: "no-store" });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : tr("mailLoadFailed"));
    return result;
  }

  useEffect(() => {
    setAccounts([]); setSelected(""); setMessages([]); setError(""); setLoaded(false);
    if (!workspaceId || app.offlineView) return;
    let live = true;
    void json("/api/mail/gmail?workspaceId=" + encodeURIComponent(workspaceId))
      .then((data) => { if (live) { setAccounts(data.accounts as Account[]); setLoaded(true); } })
      .catch(() => { if (live) { setError(tr("mailLoadFailed")); setLoaded(true); } });
    return () => { live = false; };
    // app object changes every render; the workspace is the only API scoping dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, app.offlineView]);

  async function connect() {
    if (!workspaceId || busy) return;
    setBusy(true); setError("");
    try {
      const data = await json("/api/mail/gmail", { action: "start", workspaceId });
      if (typeof data.url !== "string") throw new Error("Missing authorization URL");
      window.location.assign(data.url);
    } catch { setError(tr("mailConnectFailed")); setBusy(false); }
  }

  async function disconnect(account: Account) {
    if (busy || !workspaceId) return;
    if (!(await app.askConfirm({ title: tr("mailDisconnectTitle"), message: tr("mailDisconnectConfirm"),
      confirmLabel: tr("disconnect"), danger: true }))) return;
    setBusy(true); setError("");
    try {
      await json("/api/mail/gmail", { action: "disconnect", workspaceId, accountId: account.id });
      setAccounts((prior) => prior.filter((row) => row.id !== account.id));
      if (selected === account.id) { setSelected(""); setMessages([]); }
    } catch { setError(tr("mailDisconnectFailed")); }
    finally { setBusy(false); }
  }

  async function openFolder(account: Account, nextFolder: Folder) {
    if (busy || !workspaceId) return;
    setBusy(true); setError(""); setMessages([]);
    setSelected(account.id); setFolder(nextFolder);
    try {
      const data = await json("/api/mail/gmail/messages", {
        workspaceId, accountId: account.id, folder: nextFolder, q: query.trim(),
      });
      setMessages(data.messages as Message[]);
    } catch { setError(tr("mailReadFailed")); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="sectionHeading">
        <div>
          <h2>{tr("settingsMail")}</h2>
          <p>{tr("mailInfo")}</p>
        </div>
        <span className="installStatus">{tr("readOnly")}</span>
      </div>
      {!workspaceId ? <p role="status">{tr("mailChooseWorkspace")}</p> :
        app.offlineView ? <p role="status">{tr("assistantOffline")}</p> : (
        <>
          <div className="notificationActions">
            <button className="primaryAction" disabled={busy} onClick={() => void connect()}>{tr("mailConnectGmail")}</button>
          </div>
          {loaded && accounts.length === 0 && <p>{tr("mailNoAccounts")}</p>}
          <div className="calendarSources">
            {accounts.map((account) => (
              <div key={account.id}>
                <span><strong>{account.email}</strong><small>Gmail · {tr("readOnly")}</small></span>
                <div className="notificationActions">
                  <button disabled={busy} onClick={() => void openFolder(account, "inbox")}>{tr("mailInbox")}</button>
                  <button disabled={busy} onClick={() => void openFolder(account, "sent")}>{tr("mailSent")}</button>
                  <button disabled={busy} onClick={() => void disconnect(account)}>{tr("disconnect")}</button>
                </div>
              </div>
            ))}
          </div>
          {selected && <div>
            <h3>{folder === "inbox" ? tr("mailInbox") : tr("mailSent")}</h3>
            <label>{tr("mailSearch")}
              <input value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <button disabled={busy} onClick={() => {
              const account = accounts.find((row) => row.id === selected);
              if (account) void openFolder(account, folder);
            }}>{tr("search")}</button>
            {messages.length === 0 && !busy && <p>{tr("mailNoMessages")}</p>}
            <div className="calendarSources">
              {messages.map((message) => (
                <div key={message.id}>
                  <span>
                    <strong>{message.subject || tr("untitledItem")}{message.unread ? " · ●" : ""}</strong>
                    <small>{folder === "inbox" ? message.from : message.to} · {message.date}</small>
                    <small>{message.snippet}</small>
                  </span>
                </div>
              ))}
            </div>
          </div>}
          {busy && <p role="status">{tr("syncing")}</p>}
          {error && <p role="alert" className="formError">{error}</p>}
        </>
      )}
      <p className="settingsHint">{language === "cs"
        ? "Zprávy se načítají až na vyžádání. Lumi je zatím neukládá ani automaticky neposílá AI."
        : "Messages are loaded only on request. Lumi does not yet store them or send them to AI."}</p>
    </>
  );
}
