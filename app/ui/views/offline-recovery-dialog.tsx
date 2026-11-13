"use client";
import { useLayoutEffect, useRef } from "react";
import type { LumiApp } from "../use-lumi-app";
import { ownerAdoptionFencePresent } from "../../../lib/owner-adoption-barrier";

// Non-dismissible safety barrier: the local copy is never discarded by closing
// a modal, reloading the page or acknowledging a download prompt.
export function OfflineRecoveryDialog({ app }: { app: LumiApp }) {
  const ref = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inspectRef = useRef(app.inspectOfflineRecoveryFile);
  inspectRef.current = app.inspectOfflineRecoveryFile;
  const cs = app.language === "cs";
  const interruptedOwnerRestore = ownerAdoptionFencePresent();
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !app.recoveryHeld) return;
    if (!dialog.open) dialog.showModal();
  }, [app.recoveryHeld]);
  // React's input props do not expose a typed onCancel. Listen for the native
  // file-picker event and stop it before it reaches the non-dismissible dialog.
  useLayoutEffect(() => {
    const input = fileInputRef.current;
    if (!input || !app.recoveryHeld) return;
    const onFilePickerCancel = (event: Event) => {
      event.stopPropagation();
      input.value = "";
      void inspectRef.current(null);
    };
    input.addEventListener("cancel", onFilePickerCancel);
    return () => input.removeEventListener("cancel", onFilePickerCancel);
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
          {interruptedOwnerRestore
            ? cs
              ? "Obnova byla přerušena. Lumi zastavilo zápisy, aby nedošlo k další ztrátě případně zbývajících místních dat."
              : "The restore was interrupted. Lumi has blocked writes to protect any local data that may remain."
            : cs
              ? "Na serveru byla obnovena jiná kopie dat. Lumi pozastavilo synchronizaci, aby nepřepsalo změny uložené v tomto prohlížeči. Vaše poznámky a rozpracované texty zatím zůstávají zde."
              : "A different copy of your data was restored on the server. Lumi paused synchronization to avoid overwriting changes saved in this browser. Your notes and drafts remain here for now."}
        </p>
        {app.ownerFenceRawRescueReason !== null && <p role="alert">
          {app.ownerFenceRawRescueReason === "unreadable"
            ? cs
              ? "Nepodařilo se přečíst údaje o přerušené obnově. Můžete si uložit kopii dat, která v tomto prohlížeči ještě zůstala, pro ruční záchranu. Soubor nelze přímo načíst zpět ani automaticky sloučit."
              : "The information needed to resume the interrupted restore cannot be read. You can save a copy of the data still in this browser for manual recovery. The file cannot be imported or merged automatically."
            : app.ownerFenceRawRescueReason === "verification-unavailable"
              ? cs
                ? "Server teď není dostupný nebo nebylo možné obnovu ověřit. Vaše místní data zůstávají chráněná. Až bude spojení fungovat, načtěte stránku znovu; případně si stáhněte kopii dat pro ruční záchranu."
                : "The server is unavailable or the restore could not be verified. Your local data stays protected. Reload when the connection works again, or save a copy for manual recovery."
              : cs
                ? "Obnovu nelze nyní bezpečně dokončit, protože jiná záložka může pracovat se stejnými daty. Místní změny zůstávají chráněné. Uložte si jejich kopii pro ruční záchranu; soubor nelze automaticky importovat ani sloučit."
                : "The restore cannot finish safely right now because another tab may be using the same data. Your local changes remain protected. You can save a copy for manual recovery, but it cannot be imported or merged automatically."}
        </p>}
        {interruptedOwnerRestore && <p role="status">
          {cs
            ? "Předchozí obnova byla přerušena. Místní kopie už může být částečně nahrazená; záchranný soubor nemusí obsahovat všechny původní změny."
            : "A previous restore was interrupted. The local copy may already be partially replaced; a recovery file may not include all earlier edits."}
        </p>}
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
        {app.recoveryReady && app.recoveryOffline && !app.recoveryError && <p role="status">
          {cs
            ? "Soubor je připraven pouze z lokálních dat. Aktuální stav serveru nešlo ověřit; soubor bude označen jako neověřený a nesmí se automaticky importovat ani sloučit."
            : "This file was prepared using local data only. The current server state could not be verified. The download is labeled unverified and must never be replayed or merged automatically."}
        </p>}
        {app.recoveryReady && !app.recoveryError && <p role="status">
          {cs
            ? "Soubor je připravený. Klikněte na Stáhnout soubor; samotné připravení nic neukládá."
            : "The file is ready. Select Download file; preparing alone does not save it."}
        </p>}
        {app.ownerFenceRawRescueReason === null && <section aria-labelledby="offline-recovery-review-title">
          <h3 id="offline-recovery-review-title">
            {cs ? "3. Zkontrolovat uložený soubor" : "3. Inspect a saved recovery file"}
          </h3>
          <p>
            {cs
              ? "Vyberte záchranný JSON soubor z tohoto zařízení. Lumi ho pouze lokálně ověří proti aktuální kopii serveru; soubor se nikam neodesílá."
              : "Select a rescue JSON file from this device. Lumi checks it locally against a fresh server snapshot; it is never uploaded."}
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            aria-label={cs ? "Vybrat záchranný JSON soubor" : "Choose recovery JSON file"}
            disabled={app.recoveryInspecting}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0] ?? null;
              event.currentTarget.value = "";
              void app.inspectOfflineRecoveryFile(file);
            }}
          />
          {app.recoveryInspecting && <p role="status">{cs ? "Kontroluji soubor…" : "Inspecting the file…"}</p>}
          {app.recoveryInspectionError === "server" && <p role="alert">
            {cs
              ? "Aktuální serverová data nelze ověřit. Soubor nebyl porovnán, místní změny zůstávají chráněné."
              : "The current server copy could not be verified. No comparison was made; local changes remain protected."}
          </p>}
          {app.recoveryInspectionError === "invalid" && <p role="alert">
            {cs
              ? "Soubor neprošel kontrolou obsahu nebo se během kontroly změnil stav obnovy. Nic nebylo importováno."
              : "The file failed validation, or recovery state changed during inspection. Nothing was imported."}
          </p>}
          {app.recoveryInspection && <div role="status">
            <p>
              {cs ? "Výsledek pouze pro ruční posouzení, nikoli k obnovení synchronizace." :
                "Read-only diagnosis for manual review, not permission to resume syncing."}
            </p>
            <p>
              {cs ? "Změněné položky" : "Changed records"}: {app.recoveryInspection.counts.entities}
              {" · "}{cs ? "vazby" : "relations"}: {app.recoveryInspection.counts.relations}
              {" · "}{cs ? "rozpracované texty" : "drafts"}: {app.recoveryInspection.counts.drafts}
              {" · "}{cs ? "čekající smazání" : "pending deletions"}: {app.recoveryInspection.counts.deletions}
              {" · "}{cs ? "obnovení" : "pending revivals"}: {app.recoveryInspection.counts.revivals}
            </p>
            <p>
              {cs ? "Celkem posouzených změn položek a vazeb" : "Total classified entity and relation changes"}: {app.recoveryInspection.totalCandidates}
            </p>
            <p>
              {cs ? "Změněno i na serveru" : "Also changed on server"}: {app.recoveryInspection.reasons["remote-diverged"]}
              {" · "}{cs ? "chybí na serveru" : "Missing on server"}: {app.recoveryInspection.reasons["remote-missing"]}
              {" · "}{cs ? "kolize ID" : "ID collisions"}: {app.recoveryInspection.reasons["id-collision"]}
              {" · "}{cs ? "jiný pracovní prostor" : "Changed workspace"}: {app.recoveryInspection.reasons["workspace-changed"]}
            </p>
            <p>
              {cs ? "Pouze místní změna" : "Local change only"}: {app.recoveryInspection.reasons["local-change"]}
              {" · "}{cs ? "již odpovídá serveru" : "Already matches server"}: {app.recoveryInspection.reasons["already-present"]}
              {" · "}{cs ? "již smazáno na serveru" : "Already deleted on server"}: {app.recoveryInspection.reasons["already-deleted"]}
            </p>
            <p>
              {cs
                ? "I nulový počet změn neznamená souhlas s jejich smazáním. Změny oprávnění a vlastnictví se musí ověřit zvlášť. Synchronizace zůstává zablokovaná."
                : "Even zero changes is not consent to discard. Permissions and ownership require separate review. Synchronization remains blocked."}
            </p>
          </div>}
        </section>}
        {app.recoveryDownloadRequested && <p role="status">
          {cs
            ? "Stahování bylo vyžádáno. Ověřte, že soubor skutečně existuje a lze ho bezpečně uchovat. Synchronizace zůstává zablokovaná."
            : "Download was requested. Verify the file actually exists and keep it secure. Synchronization remains blocked."}
        </p>}
      </div>
    </dialog>
  );
}
