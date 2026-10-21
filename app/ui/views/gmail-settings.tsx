"use client";

import { useEffect, useRef, useState } from "react";
import type { LumiApp } from "../use-lumi-app";

type Account = { id: string; email: string; workspaceId: string };
type Message = { id: string; subject: string; from: string; to: string; date: string; snippet: string; unread: boolean };
type Folder = "inbox" | "sent";
type Detail = { id: string; threadId: string; subject: string; from: string; to: string; date: string; text: string; truncated: boolean };
type Thread = { id: string; total: number; omitted: number; messages: Message[] };
type SyncState = { accountId: string; workspaceId: string; enabled: boolean; retentionDays: number; lastSyncedAt: number | null; indexedCount: number };

export function GmailSettings({ app }: { app: LumiApp }) {
  const { language, tr } = app;
  const workspaceId = app.activeWorkspaceId === "all" ? "" : app.activeWorkspaceId;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [syncStates, setSyncStates] = useState<SyncState[]>([]);
  const [retentions, setRetentions] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState("");
  const [folder, setFolder] = useState<Folder>("inbox");
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [threadBusy, setThreadBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [createdTaskId, setCreatedTaskId] = useState("");
  const detailVersion = useRef(0);
  const taskCreateInFlight = useRef(false);
  const label = (cs: string, en: string) => language === "cs" ? cs : en;

  async function json(url: string, body?: Record<string, unknown>) {
    const response = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), cache: "no-store" } : { cache: "no-store" });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : tr("mailLoadFailed"));
    return result;
  }

  useEffect(() => {
    detailVersion.current++;
    setAccounts([]); setSyncStates([]); setRetentions({}); setSelected(""); setMessages([]); setDetail(null); setThread(null); setThreadBusy(false); setError(""); setLoaded(false);
    if (!workspaceId || app.offlineView) return;
    let live = true;
    void Promise.all([
      json("/api/mail/gmail?workspaceId=" + encodeURIComponent(workspaceId)),
      json("/api/mail/gmail/sync", { action: "status", workspaceId }),
    ]).then(([data, sync]) => { if (live) {
      setAccounts(data.accounts as Account[]);
      setSyncStates(sync.accounts as SyncState[]);
      setLoaded(true);
    } })
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
    if (busy || taskCreateInFlight.current || !workspaceId) return;
    if (!(await app.askConfirm({ title: tr("mailDisconnectTitle"), message: tr("mailDisconnectConfirm"),
      confirmLabel: tr("disconnect"), danger: true }))) return;
    setBusy(true); setError("");
    try {
      await json("/api/mail/gmail", { action: "disconnect", workspaceId, accountId: account.id });
      setAccounts((prior) => prior.filter((row) => row.id !== account.id));
      setSyncStates((prior) => prior.filter((row) => row.accountId !== account.id));
      if (selected === account.id) {
        detailVersion.current++;
        setSelected(""); setMessages([]); setDetail(null); setThread(null); setThreadBusy(false); setCreatedTaskId("");
      }
    } catch { setError(tr("mailDisconnectFailed")); }
    finally { setBusy(false); }
  }

  async function changeSync(account: Account, action: "enable" | "disable" | "sync") {
    if (!workspaceId || busy || taskCreateInFlight.current) return;
    if (action === "disable" && !(await app.askConfirm({
      title: label("Vypnout synchronizaci Gmailu?", "Disable Gmail sync?"),
      message: label("Smažou se všechna uložená metadata tohoto účtu. Připojení Gmailu zůstane zachováno.",
        "All indexed metadata for this account will be deleted. The Gmail connection is kept."),
      confirmLabel: label("Vypnout a smazat", "Disable and delete"), danger: true,
    }))) return;
    setBusy(true); setError("");
    try {
      const data = await json("/api/mail/gmail/sync", {
        action, workspaceId, accountId: account.id,
        ...(action === "enable" ? { retentionDays: retentions[account.id] || 30 } : {}),
      });
      if (action === "sync") {
        const status = await json("/api/mail/gmail/sync", { action: "status", workspaceId });
        setSyncStates(status.accounts as SyncState[]);
      } else {
        setSyncStates(data.accounts as SyncState[]);
      }
    } catch {
      setError(label("Synchronizace Gmailu se nezdařila.", "Gmail sync operation failed."));
    } finally { setBusy(false); }
  }

  async function openFolder(account: Account, nextFolder: Folder) {
    if (busy || taskCreateInFlight.current || !workspaceId) return;
    detailVersion.current++;
    setBusy(true); setError(""); setMessages([]); setDetail(null); setThread(null); setThreadBusy(false); setCreatedTaskId("");
    setSelected(account.id); setFolder(nextFolder);
    try {
      const data = await json("/api/mail/gmail/messages", {
        workspaceId, accountId: account.id, folder: nextFolder, q: query.trim(),
      });
      setMessages(data.messages as Message[]);
    } catch { setError(tr("mailReadFailed")); }
    finally { setBusy(false); }
  }

  async function openDetail(account: Account, messageId: string, preserveThread = false) {
    if (taskCreateInFlight.current) return;
    const version = ++detailVersion.current;
    setDetail(null); if (!preserveThread) { setThread(null); setThreadBusy(false); }
    setCreatedTaskId(""); setTaskTitle(""); setDetailBusy(true); setError("");
    try {
      const data = await json("/api/mail/gmail/message", { workspaceId, accountId: account.id, messageId });
      if (detailVersion.current !== version) return;
      const message = data.message as Detail;
      setDetail(message);
      setTaskTitle((message.subject ? label("Vyřídit: ", "Handle: ") + message.subject : label("Vyřídit e-mail", "Handle email")).slice(0, 200));
    } catch {
      if (detailVersion.current === version) setError(label("Zprávu se nepodařilo načíst.", "The message could not be loaded."));
    } finally {
      if (detailVersion.current === version) setDetailBusy(false);
    }
  }

  function closeMailDetail() {
    // Closing the detail invalidates any in-flight conversation lookup. Its
    // finally block deliberately ignores stale versions, so release the busy
    // state here rather than leaving the spinner locked on indefinitely.
    detailVersion.current++;
    setDetail(null);
    setCreatedTaskId("");
    setThreadBusy(false);
  }

  async function openThread(account: Account, threadId: string) {
    if (taskCreateInFlight.current || busy || threadBusy || !/^[0-9a-f]{5,64}$/i.test(threadId)) return;
    const version = ++detailVersion.current;
    setThreadBusy(true); setThread(null); setError("");
    try {
      const data = await json("/api/mail/gmail/thread", { workspaceId, accountId: account.id, threadId });
      if (detailVersion.current === version) setThread(data.thread as Thread);
    } catch {
      if (detailVersion.current === version)
        setError(label("Konverzaci se nepodařilo načíst.", "The conversation could not be loaded."));
    } finally {
      if (detailVersion.current === version) setThreadBusy(false);
    }
  }

  useEffect(() => {
    const source = app.mailSourceToOpen;
    if (!source || !loaded || source.workspaceId !== workspaceId) return;
    // Consume before requesting the detail to prevent duplicate fetches on
    // unrelated React renders. Nothing is written to device storage or the URL.
    app.setMailSourceToOpen(null);
    const account = accounts.find((row) => row.id === source.accountId);
    if (!account) {
      setError(label("Zdrojový Gmail účet již není připojen.", "The source Gmail account is no longer connected."));
      return;
    }
    setSelected(account.id);
    setMessages([]);
    void openDetail(account, source.messageId);
    // app and the helper are recreated each render; these primitives capture the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.mailSourceToOpen, accounts, loaded, workspaceId]);

  async function createMailTask() {
    if (!detail || !taskTitle.trim() || !selected || !workspaceId || taskCreateInFlight.current || createdTaskId) return;
    const account = accounts.find((item) => item.id === selected);
    if (!account) return;
    taskCreateInFlight.current = true;
    setTaskBusy(true); setError("");
    try {
      // A deliberate user click is the only write. Persist source identifiers,
      // never the original mail body, access token or remote HTML.
      const id = await app.create("task", taskTitle.trim(), {
        // This is a literal, user-approved email-derived title; never reinterpret
        // words or date/priority markers as Quick Capture commands.
        workspaceId, inbox: true, today: false, literalTaskTitle: true,
        originalCaptureText: taskTitle.trim().slice(0, 1000),
        mailSource: { provider: "gmail", accountId: account.id, messageId: detail.id, threadId: detail.threadId },
      });
      if (id) setCreatedTaskId(id);
    } catch {
      setError(label("Úkol se nepodařilo vytvořit.", "The task could not be created."));
    } finally { taskCreateInFlight.current = false; setTaskBusy(false); }
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
                <div className="icloudForm">
                  <h4>{label("Synchronizace metadat", "Metadata sync")}</h4>
                  {(() => {
                    const state = syncStates.find((row) => row.accountId === account.id);
                    const days = retentions[account.id] ?? state?.retentionDays ?? 30;
                    return (
                      <>
                        <p className="settingsHint">{label(
                          "Volitelné. Ukládají se jen identifikátory zpráv, předmět, odesílatel, datum a stav Doručené/Odeslané. Nikdy těla ani přílohy. Automatické kontroly zatím nejsou zapnuté.",
                          "Optional. Stores only message identifiers, subject, sender, date and Inbox/Sent state. Never bodies or attachments. Automatic checks are not enabled yet.",
                        )}</p>
                        <label>{label("Uchovávání", "Retention")}
                          <select value={days} disabled={busy} onChange={(event) =>
                            setRetentions((old) => ({ ...old, [account.id]: Number(event.target.value) }))}>
                            <option value={7}>{label("7 dní", "7 days")}</option>
                            <option value={30}>{label("30 dní", "30 days")}</option>
                            <option value={90}>{label("90 dní", "90 days")}</option>
                          </select>
                        </label>
                        <p role="status">{state
                          ? label("Synchronizace zapnutá", "Sync enabled") + " · " +
                            state.indexedCount + " " + label("záznamů", "records") +
                            (state.lastSyncedAt ? " · " + new Date(state.lastSyncedAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB") : "")
                          : label("Synchronizace vypnutá", "Sync disabled")}</p>
                        <div className="notificationActions">
                          <button disabled={busy} onClick={() => void changeSync(account, "enable")}>
                            {state ? label("Uložit uchovávání", "Save retention") : label("Zapnout synchronizaci", "Enable sync")}
                          </button>
                          {state && <>
                            <button disabled={busy} onClick={() => void changeSync(account, "sync")}>
                              {label("Synchronizovat nyní", "Sync now")}
                            </button>
                            <button disabled={busy} onClick={() => void changeSync(account, "disable")}>
                              {label("Vypnout a smazat metadata", "Disable and delete metadata")}
                            </button>
                          </>}
                        </div>
                      </>
                    );
                  })()}
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
                    <button type="button" disabled={busy || detailBusy || taskBusy} onClick={() => {
                      const account = accounts.find((row) => row.id === selected);
                      if (account) void openDetail(account, message.id);
                    }}>{label("Přečíst zprávu", "Read message")}</button>
                  </span>
                </div>
              ))}
            </div>
          </div>}
          {threadBusy && <p role="status">{label("Načítám konverzaci…", "Loading conversation…")}</p>}
          {thread && !threadBusy && (
            <section aria-label={label("Konverzace Gmail", "Gmail conversation")} className="icloudForm">
              <div className="sectionHeading">
                <h3>{label("Konverzace", "Conversation")} ({thread.total})</h3>
                <button type="button" onClick={() => setThread(null)}>{label("Zavřít konverzaci", "Close conversation")}</button>
              </div>
              {thread.omitted > 0 && <p role="status">{label("Starších zpráv nezobrazeno: ", "Older messages not shown: ")}{thread.omitted}</p>}
              <div className="calendarSources">
                {thread.messages.map((message) => (
                  <div key={message.id}>
                    <span>
                      <strong>{message.subject || tr("untitledItem")}{message.unread ? " · ●" : ""}</strong>
                      <small>{message.from} · {message.date}</small>
                      <small>{message.snippet}</small>
                      <button type="button" disabled={detailBusy || taskBusy} onClick={() => {
                        const account = accounts.find((row) => row.id === selected);
                        if (account) void openDetail(account, message.id, true);
                      }}>{label("Přečíst v konverzaci", "Read in conversation")}</button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {detailBusy && <p role="status">{label("Načítám zprávu…", "Loading message…")}</p>}
          {detail && !detailBusy && (
            <section aria-label={label("Detail e-mailu", "Email detail")} className="icloudForm">
              <div className="sectionHeading">
                <h3>{detail.subject || tr("untitledItem")}</h3>
                <button type="button" disabled={taskBusy} onClick={closeMailDetail}>
                  {label("Zavřít", "Close")}
                </button>
              </div>
              <p><strong>{label("Od", "From")}:</strong> {detail.from}</p>
              <p><strong>{label("Komu", "To")}:</strong> {detail.to}</p>
              <p><strong>{label("Datum", "Date")}:</strong> {detail.date}</p>
              {/^[0-9a-f]{5,64}$/i.test(detail.threadId) && (
                <button type="button" disabled={threadBusy || taskBusy} onClick={() => {
                  const account = accounts.find((row) => row.id === selected);
                  if (account) void openThread(account, detail.threadId);
                }}>{label("Zobrazit konverzaci", "Show conversation")}</button>
              )}
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "24rem", overflowY: "auto" }}>{detail.text || label("Textová část zprávy není dostupná.", "No readable text part is available.")}</pre>
              {detail.truncated && <p role="status">{label("Zobrazuje se pouze prvních 32 000 znaků zprávy.", "Only the first 32,000 characters are shown.")}</p>}
              <div className="icloudForm">
                <h3>{label("Vytvořit úkol z e-mailu", "Create a task from email")}</h3>
                <p className="settingsHint">{label(
                  "Uprav název úkolu. Uloží se pouze název a odkaz na zdrojovou zprávu, nikoliv její obsah. Úkol vznikne až po potvrzení.",
                  "Edit the task title. Only the title and source message reference will be stored, not the email body. Nothing is created until you confirm.",
                )}</p>
                <label>{label("Název úkolu", "Task title")}
                  <input value={taskTitle} maxLength={200} disabled={taskBusy || Boolean(createdTaskId)}
                    onChange={(event) => setTaskTitle(event.target.value)} />
                </label>
                {!createdTaskId
                  ? <button type="button" className="primaryAction" disabled={!taskTitle.trim() || taskBusy} onClick={() => void createMailTask()}>
                      {taskBusy ? label("Ukládám…", "Saving…") : label("Potvrdit a vytvořit úkol", "Confirm and create task")}
                    </button>
                  : <p role="status">
                      {label("Úkol byl vytvořen v Inboxu.", "The task was created in Inbox.")}
                      {" "}
                      <button type="button" onClick={() => app.setView("Inbox")}>{label("Přejít do Inboxu", "Open Inbox")}</button>
                    </p>}
              </div>
            </section>
          )}
          {busy && <p role="status">{tr("syncing")}</p>}
          {error && <p role="alert" className="formError">{error}</p>}
        </>
      )}
      <p className="settingsHint">{language === "cs"
        ? "Obsah e-mailů se načítá jen na vyžádání a nikdy se neukládá. Metadata se ukládají pouze po výslovném zapnutí synchronizace. Nic se automaticky neposílá do AI."
        : "Email bodies are fetched only on request and never stored. Metadata is saved only after explicitly enabling sync. Nothing is automatically sent to AI."}</p>
    </>
  );
}
