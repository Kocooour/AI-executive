"use client";
import { useEffect, useState } from "react";
import type { ServerSnapshot } from "../../../lib/server-sync";
import { captureMarkers, clearSentMarkers } from "../../../lib/pending-markers";
import { clearNotesDrafts } from "../../../lib/notes-drafts";
import type { BackupSummary, ConfirmRequest, Language } from "../types";

// Server backups in Settings: the list, creating a backup and restoring one. Restoring replaces
// the local copy with the restored data and drops the changes waiting to be sent. Moved verbatim
// from use-lumi-app.tsx. The list is loaded together with the notification settings when Settings
// opens; that effect stays in use-lumi-app.tsx, so the setters are returned.
export function useBackups({ language, tr, askConfirm, applySnapshot, afterRestore }: {
  language: Language;
  tr: (key: string) => string;
  askConfirm: (request: ConfirmRequest) => Promise<boolean>;
  applySnapshot: (snapshot: ServerSnapshot) => Promise<unknown>;
  // Drops notes being typed here and asks the other tabs to do the same.
  afterRestore: () => void;
}) {
  const [backups, setBackups] = useState<BackupSummary[]>([]),
    [backupStatus, setBackupStatus] = useState("");
  // A status shown in one language is not kept after the language changes.
  useEffect(() => setBackupStatus(""), [language]);

  async function createServerBackup() {
    setBackupStatus(tr("backupCreating"));
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
      setBackupStatus(tr("backupCreated"));
    } catch {
      setBackupStatus(tr("backupFailed"));
    }
  }
  async function restoreServerBackup(backup: BackupSummary) {
    if (!(await askConfirm({ title: tr("backupRestoreTitle"), confirmLabel: tr("restore"), danger: true,
      message: tr("backupRestoreConfirm").replace("{date}", () => new Date(backup.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")) }))) return;
    setBackupStatus(tr("backupRestoring"));
    // What waits to be sent now belongs to the data the backup replaces; only that is dropped. A
    // deletion or restoration another tab records after this moment stays for its own save.
    const replaced = captureMarkers(localStorage);
    try {
      const response = await fetch("/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore", name: backup.name }),
      });
      if (!response.ok) throw new Error("Restore failed");
      const data = await response.json();
      await applySnapshot(data.snapshot as ServerSnapshot);
      clearSentMarkers(localStorage, replaced);
      // Notes drafts were typed against the replaced data: kept, they could write it back over the
      // restored notes. Open tabs drop the drafts they hold in memory too (afterRestore); the
      // stored ones of all pages go here, also of pages that are closed. (The notes of open texts
      // stay: they only make sign-out ask.)
      afterRestore();
      clearNotesDrafts(localStorage);
      setBackupStatus(tr("backupRestored"));
      const listResponse = await fetch("/api/backups", { cache: "no-store" });
      const list = await listResponse.json();
      setBackups(list.backups || []);
    } catch {
      setBackupStatus(tr("backupRestoreFailed"));
    }
  }

  return { backups, setBackups, backupStatus, setBackupStatus, createServerBackup, restoreServerBackup };
}
