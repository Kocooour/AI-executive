"use client";

import { useEffect } from "react";

function report(error: Error & { digest?: string }, scope: string) {
  fetch("/api/client-errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: scope,
      message: error.message || "React client error",
      source: location.href,
      stack: error.stack || "",
      userAgent: navigator.userAgent,
    }),
    keepalive: true,
  }).catch(() => {});
}

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => report(error, "react-error-boundary"), [error]);
  return (
    <main className="offlinePage">
      <div className="offlineCard">
        <div className="authMark">◇</div>
        <p className="eyebrow">LUMI</p>
        <h1>Aplikaci se nepodařilo načíst</h1>
        <p>Chyba byla bezpečně odeslána k diagnostice.</p>
        <button type="button" onClick={reset}>Zkusit znovu</button>
      </div>
    </main>
  );
}
