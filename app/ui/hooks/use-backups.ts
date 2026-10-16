"use client";
import { useEffect, useState } from "react";
import type { ServerSnapshot } from "../../../lib/server-sync";
import { clearNotesDrafts } from "../../../lib/notes-drafts";
import { localizeServerError } from "../../../lib/server-errors";
import type { BackupSummary, ConfirmRequest, Language } from "../types";

// Server backups in Settings: the list, creating a backup, restoring one, downloading an export and restoring from
// one. Restoring replaces the local copy with the restored data and drops the changes waiting to be sent. The list
// is loaded together with the notification settings when Settings opens; that effect stays in use-lumi-app.tsx, so
// the setters are returned.
export const maxImportBytes = 200 * 1024 * 1024;

export function useBackups({ language, tr, askConfirm, replaceLocal, afterRestore }: {
  language: Language;
  tr: (key: string) => string;
  askConfirm: (request: ConfirmRequest) => Promise<boolean>;
  // Makes the server's copy the only copy here (records, held-back records, merge base, pending changes).
  replaceLocal: (snapshot: ServerSnapshot) => Promise<unknown>;
  // Drops notes being typed here, reloads what the server holds besides the records, and tells the other tabs.
  afterRestore: () => void;
}) {
  const [backups, setBackups] = useState<BackupSummary[]>([]),
    [backupStatus, setBackupStatus] = useState(""),
    [backupBusy, setBackupBusy] = useState(false),
    [backupFailed, setBackupFailed] = useState(false);
  // A status shown in one language is not kept after the language changes.
  useEffect(() => { setBackupStatus(""); setBackupFailed(false); }, [language]);

  const dateText = (time: number) => new Date(time).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB");
  const report = (message: string, failed = false) => { setBackupStatus(message); setBackupFailed(failed); };
  async function refreshList() {
    const listResponse = await fetch("/api/backups", { cache: "no-store" });
    const list = await listResponse.json();
    setBackups(list.backups || []);
  }
  async function errorText(response: Response, fallback: string) {
    const data = await response.json().catch(() => ({}));
    return localizeServerError(data.error, tr) || fallback;
  }

  async function createServerBackup() {
    if (backupBusy) return;
    setBackupBusy(true);
    report(tr("backupCreating"));
    try {
      const response = await fetch("/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      if (!response.ok) throw new Error("Backup failed");
      await refreshList();
      report(tr("backupCreated"));
    } catch {
      report(tr("backupFailed"), true);
    } finally {
      setBackupBusy(false);
    }
  }

  // What was restored replaced the data the open notes were typed against and everything that waits to be sent: the
  // local copy is replaced by the server's, not merged with it, so nothing of the replaced data stays or comes back.
  async function applyRestored(response: Response) {
    const data = await response.json();
    await replaceLocal(data.snapshot as ServerSnapshot);
    // Notes drafts were typed against the replaced data: kept, they could write it back over the
    // restored notes. Open tabs drop the drafts they hold in memory too (afterRestore); the
    // stored ones of all pages go here, also of pages that are closed. (The notes of open texts
    // stay: they only make sign-out ask.)
    afterRestore();
    clearNotesDrafts(localStorage);
  }

  async function restoreServerBackup(backup: BackupSummary) {
    if (backupBusy) return;
    if (!(await askConfirm({ title: tr("backupRestoreTitle"), confirmLabel: tr("restore"), danger: true,
      message: tr(backup.format === "legacy" ? "backupRestoreConfirmLegacy" : "backupRestoreConfirmFull").replace("{date}", () => dateText(backup.createdAt)) }))) return;
    setBackupBusy(true);
    report(tr("backupRestoring"));
    try {
      const response = await fetch("/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore", name: backup.name }),
      });
      if (!response.ok) throw new Error(await errorText(response, tr("backupRestoreFailed")));
      await applyRestored(response);
      report(tr("backupRestored"));
      await refreshList();
    } catch (error) {
      report(error instanceof Error && error.message ? `${tr("backupRestoreFailed")} ${error.message}` : tr("backupRestoreFailed"), true);
    } finally {
      setBackupBusy(false);
    }
  }

  async function downloadExport() {
    if (backupBusy) return;
    setBackupBusy(true);
    report(tr("backupExporting"));
    try {
      const response = await fetch("/api/backups/export", { cache: "no-store" });
      if (!response.ok) throw new Error(await errorText(response, tr("backupExportFailed")));
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const name = /filename="([^"]+)"/.exec(disposition)?.[1] || "lumi-export.zip";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      report(tr("backupExported"));
    } catch (error) {
      report(error instanceof Error && error.message ? error.message : tr("backupExportFailed"), true);
    } finally {
      setBackupBusy(false);
    }
  }

  async function importExport(file: File) {
    if (backupBusy) return;
    if (file.size > maxImportBytes) { report(tr("backupFileTooLarge"), true); return; }
    if (!(await askConfirm({ title: tr("backupImportTitle"), confirmLabel: tr("restore"), danger: true,
      message: tr("backupImportConfirm").replace("{file}", () => file.name) }))) return;
    setBackupBusy(true);
    report(tr("backupImporting"));
    try {
      const response = await fetch("/api/backups/import", { method: "POST", headers: { "content-type": "application/zip" }, body: file });
      if (!response.ok) throw new Error(await errorText(response, tr("backupImportFailed")));
      await applyRestored(response);
      report(tr("backupImported"));
      await refreshList();
    } catch (error) {
      report(error instanceof Error && error.message ? `${tr("backupImportFailed")} ${error.message}` : tr("backupImportFailed"), true);
    } finally {
      setBackupBusy(false);
    }
  }

  return { backups, setBackups, backupStatus, setBackupStatus, backupBusy, backupFailed, createServerBackup, restoreServerBackup, downloadExport, importExport };
}
