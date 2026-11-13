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
              ? "Serverová data byla obnovena z jiné generace. Lumi zastavilo zápisy i přepsání místní kopie. Změny, poznámky a rozpracované texty zůstávají v tomto prohlížeči."
              : "The server's restore generation changed. Lumi has blocked writes and replacement of your local copy. Local edits, notes and drafts stay in this browser."}
        </p>
        {app.unreadableOwnerFenceRecovery && <p role="alert">
          {cs
            ? "Ochranná značka obnovy je poškozená. Není možné ověřit původní generaci. Nabízíme jen nezpracovaný lokální export pro ruční záchranu, nikoli standardní záchranný soubor. Nelze ho importovat ani automaticky sloučit."
            : "The restore marker is corrupt, so its generation cannot be verified. Only a raw local salvage file is available for manual recovery. It cannot be imported or merged automatically."}
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
        {!app.unreadableOwnerFenceRecovery && <section aria-labelledby="offline-recovery-review-title">
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
