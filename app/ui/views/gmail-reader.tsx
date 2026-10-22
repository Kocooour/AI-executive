"use client";

import { useEffect, useRef, useState } from "react";
import type { LumiApp } from "../use-lumi-app";
import { gmailJson, type Account, type Detail, type Folder, type Message, type Thread } from "./gmail-shared";

// Inbox -> From mail: previews of the connected Gmail accounts, one message or conversation on request
// and an explicit "create task" from a message. Nothing is stored except the task the user confirms.
export function GmailReader({ app }: { app: LumiApp }) {
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
  const [loadFailed, setLoadFailed] = useState(false);
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
    return gmailJson(url, body, tr("mailLoadFailed"));
  }

  // Starting a newer lookup makes any message or conversation lookup still running stale: its
  // finally block then leaves the busy state alone, so it is released here, by whoever invalidates.
  function invalidateLookups() {
    detailVersion.current++;
    setDetailBusy(false);
    setThreadBusy(false);
  }

  useEffect(() => {
    invalidateLookups();
    setBusy(false); // In-flight actions from the previous workspace no longer own this panel.
    setAccounts([]); setSelected(""); setMessages([]); setDetail(null); setThread(null); setThreadBusy(false); setError(""); setLoaded(false); setLoadFailed(false);
    if (!workspaceId || app.offlineView) return;
    let live = true;
    void json("/api/mail/gmail?workspaceId=" + encodeURIComponent(workspaceId))
      .then((data) => { if (live) { setAccounts(data.accounts as Account[]); setLoaded(true); } })
      .catch(() => { if (live) { setError(tr("mailLoadFailed")); setLoadFailed(true); setLoaded(true); } });
    return () => { live = false; };
    // app object changes every render; the workspace is the only API scoping dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, app.offlineView]);

  async function openFolder(account: Account, nextFolder: Folder) {
    if (busy || taskCreateInFlight.current || !workspaceId) return;
    invalidateLookups();
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
    invalidateLookups();
    const version = detailVersion.current;
    setDetail(null); if (!preserveThread) setThread(null);
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
    invalidateLookups();
    setDetail(null);
    setCreatedTaskId("");
  }

  async function openThread(account: Account, threadId: string) {
    if (taskCreateInFlight.current || busy || threadBusy || !/^[0-9a-f]{5,64}$/i.test(threadId)) return;
    invalidateLookups();
    const version = detailVersion.current;
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
    if (!source) return;
    // A message that cannot be applied here (another workspace, the aggregate, offline) is dropped,
    // so it can never open later without a new click.
    if (!workspaceId || app.offlineView || source.workspaceId !== workspaceId) { app.setMailSourceToOpen(null); return; }
    if (!loaded) return;
    // Consume before requesting the detail to prevent duplicate fetches on
    // unrelated React renders. Nothing is written to device storage or the URL.
    app.setMailSourceToOpen(null);
    // The accounts could not be loaded: the load error is shown; that says nothing about the account.
    if (loadFailed) return;
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
  }, [app.mailSourceToOpen, accounts, loaded, loadFailed, workspaceId]);

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

  if (!workspaceId) return <section className="mailReader" aria-label={tr("inboxTabMail")}><p role="status">{tr("mailTabAggregate")}</p></section>;
  if (app.offlineView) return <section className="mailReader" aria-label={tr("inboxTabMail")}><p role="status">{tr("assistantOffline")}</p></section>;
  return (
    <section className="mailReader" aria-label={tr("inboxTabMail")}>
      {loaded && accounts.length === 0 && !error && (
        <div className="empty mailTabEmpty">
          <p><strong>{tr("mailTabNoAccountTitle")}</strong></p>
          <p>{tr("mailTabNoAccountBody")}</p>
          <button type="button" className="primaryAction" onClick={() => { app.setSettingsSection("mail"); app.setView("Settings"); app.closeDetail(); }}>{tr("mailTabOpenSettings")}</button>
        </div>
      )}
      <div className="calendarSources">
        {accounts.map((account) => (
          <div key={account.id}>
            <span><strong>{account.email}</strong><small>Gmail · {tr("readOnly")}</small></span>
            <div className="notificationActions">
              <button disabled={busy} aria-pressed={selected === account.id && folder === "inbox"} onClick={() => void openFolder(account, "inbox")}>{tr("mailInbox")}</button>
              <button disabled={busy} aria-pressed={selected === account.id && folder === "sent"} onClick={() => void openFolder(account, "sent")}>{tr("mailSent")}</button>
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
                      <button type="button" onClick={() => app.setInboxTab("tasks")}>{label("Zobrazit úkoly", "Show tasks")}</button>
                    </p>}
              </div>
            </section>
          )}
      {busy && <p role="status">{tr("syncing")}</p>}
      {error && <p role="alert" className="formError">{error}</p>}
      <p className="settingsHint">{language === "cs"
        ? "Obsah e-mailů se načítá jen na vyžádání a nikdy se neukládá. Nic se automaticky neposílá do AI."
        : "Email bodies are fetched only on request and never stored. Nothing is automatically sent to AI."}</p>
    </section>
  );
}
