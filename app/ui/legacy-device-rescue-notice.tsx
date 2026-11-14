"use client";
import { useEffect, useRef, useState } from "react";
import { readLocalWithBase } from "../../lib/db";
import { readRawRecoveryDrafts, readRawRecoveryMarkers } from "../../lib/d2b-recovery-local";
import { createLegacyLocalCopy, detectLegacyPending, type LocalLegacyData } from "../../lib/legacy-device-rescue";
import { tabChannelName } from "../../lib/tab-coordination";

type Status = { kind: "checking" | "none" | "pending" | "error"; count: number; atLeast: boolean };
const maxCopyBytes = 24 * 1024 * 1024;

async function readLocalCopy(): Promise<LocalLegacyData> {
  const [entities, relations, base] = await readLocalWithBase();
  // Raw readers DO NOT migrate/clear legacy localStorage keys, unlike the
  // ordinary sync helpers. Even malformed drafts must never disappear.
  const markers = readRawRecoveryMarkers(localStorage);
  const drafts = readRawRecoveryDrafts(localStorage);
  return { local: { entities, relations }, base, markers, drafts };
}

// Only mounts on legacy Home / Inbox / Today while unified target mode is on.
// Never sends or uploads source data; the user explicitly downloads a private
// local JSON copy with manual review, not an automatically replayable backup.
export function LegacyDeviceRescueNotice({ language }: { language: string }) {
  const cs = language === "cs";
  const [status, setStatus] = useState<Status>({ kind: "checking", count: 0, atLeast: false });
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const version = useRef(0);

  useEffect(() => {
    let mounted = true;
    const inspect = async () => {
      const current = ++version.current;
      try {
        const assessment = detectLegacyPending(await readLocalCopy());
        if (!mounted || current !== version.current) return;
        setStatus({ kind: assessment.pending ? "pending" : "none", count: assessment.count, atLeast: assessment.atLeast });
      } catch {
        if (mounted && current === version.current) setStatus({ kind: "error", count: 0, atLeast: true });
      }
    };
    void inspect();
    // Other tabs may alter IndexedDB, shared markers or drafts while this
    // read-only tab stays open. Refresh the warning, not the local editor.
    const changed = () => { setPrepared(null); void inspect(); };
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(tabChannelName);
    if (channel) channel.onmessage = changed;
    window.addEventListener("storage", changed);
    window.addEventListener("focus", changed);
    const timer = window.setInterval(inspect, 30_000);
    return () => {
      mounted = false;
      version.current += 1;
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", changed);
      window.clearInterval(timer);
      channel?.close();
    };
  }, []);

  async function prepare() {
    if (preparing) return;
    setPreparing(true);
    setPrepared(null);
    setDownloadError(false);
    try {
      const first = await readLocalCopy();
      const second = await readLocalCopy();
      // A second tab may still be editing: never export a partial mixture.
      if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("LOCAL_SNAPSHOT_CHANGED");
      const encoded = JSON.stringify(createLegacyLocalCopy(second, Date.now()));
      if (new TextEncoder().encode(encoded).byteLength > maxCopyBytes) throw new Error("LOCAL_COPY_TOO_LARGE");
      setPrepared(encoded);
    } catch {
      setDownloadError(true);
    } finally {
      setPreparing(false);
    }
  }

  function download() {
    if (!prepared) return;
    const url = URL.createObjectURL(new Blob([prepared], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "lumi-legacy-local-copy.json";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    try { anchor.click(); } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  if (status.kind === "none" || status.kind === "checking") return null;
  return (
    <section className="legacyDeviceRescueNotice" role="status" aria-live="polite" data-testid="legacy-pending-rescue">
      {status.kind === "error" ? (
        <p>{cs ? "Na tomto zařízení nelze ověřit starší místní úpravy. Původní data zůstávají uložená; nemažte data prohlížeče." :
          "Older local changes could not be checked on this device. The original data remains stored; do not clear browser data."}</p>
      ) : (
        <>
          <p>{cs
            ? `Na tomto zařízení zůstalo ${status.atLeast ? "nejméně " : ""}${status.count} položek nebo konceptů, které se neodeslaly. V tomto režimu se už neodešlou. Můžete si uložit jejich soukromou kopii do souboru; původní data zůstávají na zařízení.`
            : `This device holds ${status.atLeast ? "at least " : ""}${status.count} unsent items or drafts. They will not be uploaded in this mode. You can save a private copy to a file; the originals remain on this device.`}</p>
          <div className="legacyDeviceRescueActions">
            <button type="button" disabled={preparing} onClick={() => void prepare()} data-testid="legacy-pending-prepare">
              {cs ? preparing ? "Připravuji kopii…" : "Připravit kopii" : preparing ? "Preparing copy…" : "Prepare copy"}
            </button>
            {prepared && <button type="button" onClick={download} data-testid="legacy-pending-download">
              {cs ? "Uložit kopii do souboru" : "Save copy to file"}
            </button>}
          </div>
          {prepared && <p className="legacyDeviceRescueHint">{cs
            ? "Soubor obsahuje osobní údaje. Uložte ho bezpečně; neprovádí automatickou obnovu."
            : "This file contains private data. Store it securely; it does not restore data automatically."}</p>}
          {downloadError && <p role="alert">{cs
            ? "Kopii se nepodařilo bezpečně připravit. Data zůstala beze změny; zkuste to znovu."
            : "The copy could not be prepared safely. Your data is unchanged; try again."}</p>}
        </>
      )}
    </section>
  );
}
