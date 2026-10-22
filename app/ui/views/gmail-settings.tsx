"use client";

import { useEffect, useRef, useState } from "react";
import type { LumiApp } from "../use-lumi-app";
import { gmailJson, type Account, type SyncState } from "./gmail-shared";

// Settings -> Mail: connecting and disconnecting Gmail accounts and the opt-in metadata
// synchronization (Mail v4). Reading mail lives in Inbox -> From mail (gmail-reader.tsx).
export function GmailAccountsSettings({ app }: { app: LumiApp }) {
  const { language, tr } = app;
  const workspaceId = app.activeWorkspaceId === "all" ? "" : app.activeWorkspaceId;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [syncStates, setSyncStates] = useState<SyncState[]>([]);
  const [syncStatusKnown, setSyncStatusKnown] = useState(false);
  const [syncWarning, setSyncWarning] = useState("");
  const [syncNotice, setSyncNotice] = useState("");
  const [retentions, setRetentions] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const syncStatusVersion = useRef(0);
  const label = (cs: string, en: string) => language === "cs" ? cs : en;

  async function json(url: string, body?: Record<string, unknown>) {
    return gmailJson(url, body, tr("mailLoadFailed"));
  }

  // Retry can be triggered without reloading the page. The version guard
  // prevents a late reply from another workspace from overwriting this one.
  async function reloadSyncStatus() {
    if (!workspaceId || app.offlineView) return;
    const version = ++syncStatusVersion.current;
    try {
      const data = await json("/api/mail/gmail/sync", { action: "status", workspaceId });
      if (version !== syncStatusVersion.current) return;
      setSyncStates(data.accounts as SyncState[]);
      setSyncStatusKnown(true);
      setSyncWarning("");
    } catch {
      if (version !== syncStatusVersion.current) return;
      setSyncWarning(label(
        "Stav synchronizace není dostupný. Připojené e-maily lze dál číst.",
        "Sync status is unavailable. Connected email can still be read.",
      ));
    }
  }

  useEffect(() => {
    syncStatusVersion.current++;
    setBusy(false); // In-flight actions from the previous workspace no longer own this panel.
    setAccounts([]); setSyncStates([]); setSyncStatusKnown(false); setRetentions({}); setError(""); setLoaded(false);
    if (!workspaceId || app.offlineView) return;
    let live = true;
    setSyncWarning(""); setSyncNotice("");
    // Mail v4 is additive: an unavailable sync-status endpoint must never hide
    // existing read-only Gmail accounts or Disconnect.
    void json("/api/mail/gmail?workspaceId=" + encodeURIComponent(workspaceId))
      .then((data) => { if (live) { setAccounts(data.accounts as Account[]); setLoaded(true); } })
      .catch(() => { if (live) { setError(tr("mailLoadFailed")); setLoaded(true); } });
    void reloadSyncStatus();
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
      setSyncStates((prior) => prior.filter((row) => row.accountId !== account.id));
    } catch { setError(tr("mailDisconnectFailed")); }
    finally { setBusy(false); }
  }

  async function changeSync(account: Account, action: "enable" | "disable" | "sync") {
    // Unknown sync state is never equivalent to disabled; otherwise we might
    // overwrite a 7-day retention policy with the default 30-day value.
    // Opt-out must remain available even when the status endpoint fails.
    if (!workspaceId || busy || (action !== "disable" && !syncStatusKnown)) return;
    const version = syncStatusVersion.current;
    const saved = syncStates.find((state) => state.accountId === account.id);
    const retentionDays = retentions[account.id] ?? saved?.retentionDays ?? 30;
    // Re-submitting an unchanged policy must not modify consent or its cursor.
    if (action === "enable" && saved && retentionDays === saved.retentionDays) return;
    if (action === "disable" && !(await app.askConfirm({
      title: label("Vypnout synchronizaci Gmailu?", "Disable Gmail sync?"),
      message: label("Smažou se všechna uložená metadata tohoto účtu. Připojení Gmailu zůstane zachováno.",
        "All indexed metadata for this account will be deleted. The Gmail connection is kept."),
      confirmLabel: label("Vypnout a smazat", "Disable and delete"), danger: true,
    }))) return;
    if (version !== syncStatusVersion.current) return; // Workspace changed during confirmation.
    setBusy(true); setError("");
    try {
      const data = await json("/api/mail/gmail/sync", {
        action, workspaceId, accountId: account.id,
        ...(action === "enable" ? { retentionDays } : {}),
      });
      if (version !== syncStatusVersion.current) return;
      if (action === "sync") {
        // The successful sync response already carries its final account state.
        // A failed follow-up status refresh must never re-label a committed
        // synchronization as failed or induce an unnecessary retry.
        if (data.state && typeof data.state === "object") {
          const synced = data.state as SyncState;
          setSyncStates((prior) => [...prior.filter((item) => item.accountId !== synced.accountId), synced]);
        }
        setSyncNotice(data.partial === true ? label(
          "Synchronizace není úplná. Spusť ji znovu pro další změny nebo ověření dříve uložených zpráv.",
          "Sync is incomplete. Run it again to process more changes or verify previously indexed messages.",
        ) : "");
      } else {
        setSyncStates(data.accounts as SyncState[]);
        setSyncNotice("");
      }
      setSyncWarning("");
      setSyncStatusKnown(true);
    } catch {
      if (version === syncStatusVersion.current)
        setError(label("Synchronizace Gmailu se nezdařila.", "Gmail sync operation failed."));
    } finally {
      if (version === syncStatusVersion.current) setBusy(false);
    }
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
          {accounts.length > 0 && (
            <p className="settingsHint mailReaderMoved">
              {tr("mailReaderMoved")}{" "}
              <button type="button" className="linkButton" data-open-mail-reader onClick={() => { app.setInboxTab("mail"); app.setView("Inbox"); app.closeDetail(); }}>{tr("mailReaderOpen")}</button>
            </p>
          )}
          <div className="calendarSources">
            {accounts.map((account) => (
              <div key={account.id}>
                <span><strong>{account.email}</strong><small>Gmail · {tr("readOnly")}</small></span>
                <div className="notificationActions">
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
                        {!syncStatusKnown && <>
                          <p role="status">{label(
                            "Stav synchronizace neznámý – zapnutí a úpravy nastavení jsou dočasně zakázány; smazání dat je stále dostupné.",
                            "Sync status unknown – enabling and editing are disabled; deleting stored metadata is still available.",
                          )}</p>
                          <button disabled={busy} onClick={() => void reloadSyncStatus()}>
                            {label("Obnovit stav synchronizace", "Retry sync status")}
                          </button>
                        </>}
                        <label>{label("Uchovávání", "Retention")}
                          <select value={days} disabled={busy || !syncStatusKnown} onChange={(event) =>
                            setRetentions((old) => ({ ...old, [account.id]: Number(event.target.value) }))}>
                            <option value={7}>{label("7 dní", "7 days")}</option>
                            <option value={30}>{label("30 dní", "30 days")}</option>
                            <option value={90}>{label("90 dní", "90 days")}</option>
                          </select>
                        </label>
                        <p role="status">{!syncStatusKnown ? label("Stav neznámý", "Unknown status") : state
                          ? label("Synchronizace zapnutá", "Sync enabled") + " · " +
                            state.indexedCount + " " + label("záznamů", "records") +
                            (state.lastSyncedAt ? " · " + new Date(state.lastSyncedAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB") : "")
                          : label("Synchronizace vypnutá", "Sync disabled")}</p>
                        {syncStatusKnown && state && state.historyPending &&
                          <p role="status">{label(
                            "Čekají další změny z historie Gmailu – synchronizuj znovu.",
                            "More Gmail history changes are pending – sync again.",
                          )}</p>}
                        {syncStatusKnown && state && state.discoveryPending &&
                          <p role="status">{label(
                            "Probíhá dohledávání dalších zpráv – synchronizuj znovu.",
                            "More mailbox messages remain to be discovered – sync again.",
                          )}</p>}
                        {syncStatusKnown && state && (state.reconciliationPending ?? 0) > 0 &&
                          <p role="status">{label(
                            "Nevyřízené ověření dřívějších metadat: ",
                            "Previously indexed messages awaiting revalidation: ",
                          )}{state.reconciliationPending}</p>}
                        <div className="notificationActions">
                          <button disabled={busy || !syncStatusKnown || Boolean(state && days === state.retentionDays)}
                             onClick={() => void changeSync(account, "enable")}>
                            {state ? label("Uložit uchovávání", "Save retention") : label("Zapnout synchronizaci", "Enable sync")}
                          </button>
                          {state && <>
                            <button disabled={busy || !syncStatusKnown} onClick={() => void changeSync(account, "sync")}>
                              {label("Synchronizovat nyní", "Sync now")}
                            </button>
                            <button disabled={busy} onClick={() => void changeSync(account, "disable")}>
                              {label("Vypnout a smazat metadata", "Disable and delete metadata")}
                            </button>
                          </>}
                          {!syncStatusKnown && <button disabled={busy} onClick={() => void changeSync(account, "disable")}>
                            {label("Vypnout a smazat metadata", "Disable and delete metadata")}
                          </button>}
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            ))}
          </div>
          {syncWarning && <p role="alert" className="settingsHint">{syncWarning}</p>}
          {syncNotice && <p role="status">{syncNotice}</p>}
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
