"use client";
import { useEffect, useState } from "react";
import type { ServerSnapshot } from "../../../lib/server-sync";
import { setAfterRestoreFlag } from "../../../lib/adoption";
import { localizeServerError } from "../../../lib/server-errors";
import type { BackupSummary, ConfirmRequest, Language } from "../types";

// Server backups in Settings: the list, creating a backup, restoring one, downloading an export and restoring from
// one. Restoring replaces the local copy with the restored data and drops the changes waiting to be sent. The list
// is loaded together with the notification settings when Settings opens; that effect stays in use-lumi-app.tsx, so
// the setters are returned.
export const maxImportBytes = 200 * 1024 * 1024;

export function useBackups({ language, tr, askConfirm, replaceLocal, writesBlocked = () => false }: {
  /** R3-FE-4a: true (and announced) when unified target mode makes legacy user writes inert. */
  writesBlocked?: () => boolean;
  language: Language;
  tr: (key: string) => string;
  askConfirm: (request: ConfirmRequest) => Promise<boolean>;
  // Makes the server's copy the only copy here (records, held-back records, merge base, pending changes).
  replaceLocal: (snapshot: ServerSnapshot) => Promise<unknown>;
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

  // The data was replaced: the server's copy becomes the only copy here and this page reloads (adoptServerCopy in
  // hooks/use-sync.ts), then shows the success message of this action (use-lumi-app.tsx reads the flag).
  async function applyRestored(response: Response, kind: "restore" | "import") {
    const data = await response.json();
    setAfterRestoreFlag(kind, true);
    // The server's restore has committed: that is the result reported, whatever happens to the local cleanup (which always
    // ends in a reload, emptying the local copy if it cannot be replaced).
    try { await replaceLocal(data.snapshot as ServerSnapshot); } catch (error) { console.error("Local cleanup after a restore failed:", error instanceof Error ? error.message : error); }
  }

  async function restoreServerBackup(backup: BackupSummary) {
    if (writesBlocked()) return;
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
      await applyRestored(response, "restore");
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
    if (writesBlocked()) return;
    if (backupBusy) return;
    if (file.size > maxImportBytes) { report(tr("backupFileTooLarge"), true); return; }
    if (!(await askConfirm({ title: tr("backupImportTitle"), confirmLabel: tr("restore"), danger: true,
      message: tr("backupImportConfirm").replace("{file}", () => file.name) }))) return;
    setBackupBusy(true);
    report(tr("backupImporting"));
    try {
      const response = await fetch("/api/backups/import", { method: "POST", headers: { "content-type": "application/zip" }, body: file });
      if (!response.ok) throw new Error(await errorText(response, tr("backupImportFailed")));
      await applyRestored(response, "import");
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
