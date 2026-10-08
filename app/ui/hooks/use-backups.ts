"use client";
import { useState } from "react";
import type { ServerSnapshot } from "../../../lib/server-sync";
import type { BackupSummary, ConfirmRequest, Language } from "../types";

// Server backups in Settings: the list, creating a backup and restoring one. Restoring replaces
// the local copy with the restored data and drops the changes waiting to be sent. Moved verbatim
// from use-lumi-app.tsx. The list is loaded together with the notification settings when Settings
// opens; that effect stays in use-lumi-app.tsx, so the setters are returned.
export function useBackups({ language, tr, askConfirm, applySnapshot, pendingKey, deletedKey, revivedKey }: {
  language: Language;
  tr: (key: string) => string;
  askConfirm: (request: ConfirmRequest) => Promise<boolean>;
  applySnapshot: (snapshot: ServerSnapshot) => Promise<unknown>;
  pendingKey: string;
  deletedKey: string;
  revivedKey: string;
}) {
  const [backups, setBackups] = useState<BackupSummary[]>([]),
    [backupStatus, setBackupStatus] = useState("");

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
    try {
      const response = await fetch("/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore", name: backup.name }),
      });
      if (!response.ok) throw new Error("Restore failed");
      const data = await response.json();
      await applySnapshot(data.snapshot as ServerSnapshot);
      localStorage.removeItem(pendingKey);
      localStorage.removeItem(deletedKey);
      localStorage.removeItem(revivedKey);
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
