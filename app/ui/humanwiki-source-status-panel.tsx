"use client";
import { useEffect, useRef, useState } from "react";
import {
  parseHumanWikiSourceStatus, type HumanWikiSourceIntent,
  type HumanWikiSourceStatus,
} from "../../lib/humanwiki-source-status-ui";

type Lang = "cs" | "en";
type DisplayState = "idle" | "loading" | "ready" | "unavailable";

const labels = {
  cs: {
    heading: "HumanWiki — stav zdrojů",
    explanation: "Pouze informace o zapsaných žádostech. Import, souhlasy ani dokončené odvolání nejsou povolené.",
    action: "Ověřit stav zdrojů", loading: "Ověřuji…",
    idle: "Stav se načítá pouze na vyžádání.",
    unavailable: "Aktuální stav nelze bezpečně ověřit. Zkuste to znovu po přihlášení a připojení.",
    chatgpt: "Export ChatGPT", claude: "Export Claude",
    noRequest: "Žádná žádost nezapsána",
    withdrawal: "Zapsaná žádost o odvolání — není dokončeno",
    grant: "Zapsaná žádost o souhlas — není schváleno",
    witnessed: "Podepsaný svědek pokrývá zaznamenané žádosti tohoto vlastníka.",
    lagging: "Poslední žádost tohoto vlastníka není pokrytá podepsaným svědkem.",
    caution: "Tato kontrola nepotvrzuje výmaz, skutečný souhlas, nezávislost svědka ani možnost importu.",
    revision: "Revize",
  },
  en: {
    heading: "HumanWiki — source status",
    explanation: "Recorded requests only. Import, consent and completed withdrawal are not authorized.",
    action: "Check source status", loading: "Checking…",
    idle: "Status is fetched only on request.",
    unavailable: "Current status cannot be verified safely. Sign in and reconnect before retrying.",
    chatgpt: "ChatGPT export", claude: "Claude export",
    noRequest: "No recorded request",
    withdrawal: "Withdrawal requested — not completed",
    grant: "Consent requested — not approved",
    witnessed: "Signed witness prefix covers this owner's recorded requests.",
    lagging: "This owner's latest request is not covered by the signed witness prefix.",
    caution: "This check does not confirm erasure, actual consent, witness independence or import authorization.",
    revision: "Revision",
  },
} as const;

function intentLabel(intent: HumanWikiSourceIntent, t: typeof labels[Lang]) {
  return intent === "withdrawal_requested" ? t.withdrawal :
    intent === "grant_requested" ? t.grant : t.noRequest;
}

/**
 * Rendered only inside the currently authorized Context screen AND after
 * server-side opt-in. Never auto-fetch, cache, log, persist or reuse a result
 * across navigation / visibility / workspace identity changes.
 */
export function HumanWikiSourceStatusPanel({ language }: { language: Lang }) {
  const t = labels[language];
  const [state, setState] = useState<DisplayState>("idle");
  const [status, setStatus] = useState<HumanWikiSourceStatus | null>(null);
  const controller = useRef<AbortController | null>(null);
  const requestEpoch = useRef(0);

  useEffect(() => {
    const forget = () => {
      requestEpoch.current++;
      controller.current?.abort();
      controller.current = null;
      setStatus(null);
      setState("idle");
    };
    const hidden = () => { if (document.visibilityState !== "visible") forget(); };
    const stopped = () => forget();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", stopped);
    window.addEventListener("offline", stopped);
    window.addEventListener("blur", stopped);
    return () => {
      requestEpoch.current++;
      controller.current?.abort();
      controller.current = null;
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", stopped);
      window.removeEventListener("offline", stopped);
      window.removeEventListener("blur", stopped);
    };
  }, []);

  async function check() {
    const epoch = ++requestEpoch.current;
    controller.current?.abort();
    const signalController = new AbortController();
    controller.current = signalController;
    setStatus(null);
    if (typeof navigator === "undefined" || !navigator.onLine ||
        document.visibilityState !== "visible") {
      setState("unavailable");
      return;
    }
    setState("loading");
    try {
      const response = await fetch("/api/humanwiki/source-witness-status", {
        method: "GET", credentials: "same-origin", cache: "no-store",
        headers: { accept: "application/json" }, signal: signalController.signal,
      });
      if (response.status !== 200 ||
          !response.headers.get("content-type")?.toLowerCase().includes("application/json") ||
          !response.headers.get("cache-control")?.toLowerCase().includes("no-store"))
        throw Error("unavailable");
      const parsed = parseHumanWikiSourceStatus(await response.json());
      if (!parsed) throw Error("unavailable");
      if (requestEpoch.current !== epoch || signalController.signal.aborted ||
          document.visibilityState !== "visible" || !navigator.onLine) return;
      setStatus(parsed);
      setState("ready");
    } catch {
      if (requestEpoch.current === epoch && !signalController.signal.aborted) {
        setStatus(null);
        setState("unavailable");
      }
    } finally {
      if (requestEpoch.current === epoch) controller.current = null;
    }
  }

  return (
    <section aria-labelledby="humanwiki-source-status-heading" data-testid="humanwiki-source-status"
      style={{ padding: "1rem", marginBlock: "1rem", border: "1px solid var(--border, #bbb)", borderRadius: "0.75rem" }}>
      <h3 id="humanwiki-source-status-heading">{t.heading}</h3>
      <p>{t.explanation}</p>
      <button type="button" onClick={() => void check()} disabled={state === "loading"}>
        {state === "loading" ? t.loading : t.action}
      </button>
      {state === "idle" && <p role="status">{t.idle}</p>}
      {state === "loading" && <p role="status" aria-live="polite">{t.loading}</p>}
      {state === "unavailable" && <p role="alert">{t.unavailable}</p>}
      {state === "ready" && status && (
        <div role="status" aria-live="polite" data-testid="humanwiki-source-status-result">
          <p>{status.witnessState === "signed_witness_prefix_covers_owner_intents"
            ? t.witnessed : t.lagging}</p>
          <ul>
            <li><strong>{t.chatgpt}:</strong>{" "}
              {intentLabel(status.sources.chatgpt_user_export.latestIntent, t)}
              {" · "}{t.revision}: {status.sources.chatgpt_user_export.revision}</li>
            <li><strong>{t.claude}:</strong>{" "}
              {intentLabel(status.sources.claude_user_export.latestIntent, t)}
              {" · "}{t.revision}: {status.sources.claude_user_export.revision}</li>
          </ul>
          <p>{t.caution}</p>
        </div>
      )}
    </section>
  );
}
