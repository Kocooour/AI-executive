"use client";
import { useLayoutEffect, useRef } from "react";
import type { LumiApp } from "../use-lumi-app";

// Non-dismissible safety barrier: the local copy is never discarded by closing
// a modal, reloading the page or acknowledging a download prompt.
export function OfflineRecoveryDialog({ app }: { app: LumiApp }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cs = app.language === "cs";
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !app.recoveryHeld) return;
    if (!dialog.open) dialog.showModal();
  }, [app.recoveryHeld]);
  if (!app.recoveryHeld) return null;
  return (
    <dialog
      ref={ref}
      className="confirmDialog"
      role="alertdialog"
      aria-labelledby="offline-recovery-title"
      aria-describedby="offline-recovery-desc"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="confirmDialogBody">
        <h2 id="offline-recovery-title">{cs ? "Lokální změny jsou chráněné" : "Local changes are protected"}</h2>
        <p id="offline-recovery-desc">
          {cs
            ? "Serverová data byla obnovena z jiné generace. Lumi zastavilo zápisy i přepsání místní kopie. Změny, poznámky a rozpracované texty zůstávají v tomto prohlížeči."
            : "The server's restore generation changed. Lumi has blocked writes and replacement of your local copy. Local edits, notes and drafts stay in this browser."}
        </p>
        <p>
          {cs
            ? "Soubor může obsahovat soukromé údaje. Uložte ho pouze na bezpečné místo. Export není automatické sloučení; pro opětovné zapnutí synchronizace bude potřeba samostatné bezpečné rozhodnutí."
            : "The recovery file may contain private information. Store it securely. Export does not merge changes; resuming synchronization requires a separate reviewed action."}
        </p>
        <div className="confirmDialogActions">
          <button type="button" disabled={app.recoveryPreparing} onClick={() => void app.prepareOfflineRecoveryDownload()}>
            {app.recoveryPreparing
              ? cs ? "Připravuji…" : "Preparing…"
              : cs ? "1. Připravit záchranný soubor" : "1. Prepare recovery file"}
          </button>
          <button
            type="button"
            className="confirmPrimary"
            disabled={!app.recoveryReady || app.recoveryPreparing}
            onClick={app.downloadOfflineRecovery}
          >
            {cs ? "2. Stáhnout soubor" : "2. Download file"}
          </button>
        </div>
        {app.recoveryError && <p role="alert">
          {cs
            ? "Soubor se nepodařilo bezpečně připravit. Místní data zůstala beze změny. Nevypínejte úložiště prohlížeče ani nemažte data webu."
            : "The file could not be prepared safely. Your local data has been preserved. Do not clear browser storage or site data."}
        </p>}
        {app.recoveryReady && !app.recoveryError && <p role="status">
          {cs
            ? "Soubor je připravený. Klikněte na Stáhnout soubor; samotné připravení nic neukládá."
            : "The file is ready. Select Download file; preparing alone does not save it."}
        </p>}
        {app.recoveryDownloadRequested && <p role="status">
          {cs
            ? "Stahování bylo vyžádáno. Ověřte, že soubor skutečně existuje a lze ho bezpečně uchovat. Synchronizace zůstává zablokovaná."
            : "Download was requested. Verify the file actually exists and keep it secure. Synchronization remains blocked."}
        </p>}
      </div>
    </dialog>
  );
}
