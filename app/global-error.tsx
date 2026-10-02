"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    fetch("/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "react-global-error",
        message: error.message || "React global error",
        source: location.href,
        stack: error.stack || "",
        userAgent: navigator.userAgent,
      }),
      keepalive: true,
    }).catch(() => {});
  }, [error]);
  return (
    <html lang="cs">
      <body>
        <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", fontFamily: "-apple-system, sans-serif" }}>
          <div style={{ width: "min(82vw, 360px)", textAlign: "center" }}>
            <div style={{ fontSize: 38 }}>◇</div>
            <h1>Aplikaci se nepodařilo načíst</h1>
            <p>Chyba byla bezpečně odeslána k diagnostice.</p>
            <button type="button" onClick={reset}>Zkusit znovu</button>
          </div>
        </main>
      </body>
    </html>
  );
}
