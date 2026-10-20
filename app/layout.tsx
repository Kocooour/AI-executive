import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
// Runtime uses the same generated tokens as the design-system previews.
import "../docs/design-system/tokens.css";
import "./lumi-navigation.css";
import "./lumi-home.css";
import "./lumi-task-row.css";
import "./lumi-mobile-more.css";
import "./lumi-inspector.css";
import "./lumi-project-overview.css";
import "./lumi-capture-b3.css";
import { PWARegister } from "./pwa-register";

export const metadata: Metadata = {
  title: "Lumi",
  description: "A proactive personal AI Executive for tasks, projects and context.",
  applicationName: "Lumi",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Lumi",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/lumi-icon-v3-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/lumi-icon-v3-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [
      { url: "/icons/lumi-icon-v3-180.png", sizes: "180x180", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

const themeBootstrap = `
  try {
    const saved = localStorage.getItem("ai-executive-theme") || "system";
    const dark = saved === "dark" || (saved === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    const resolved = dark ? "dark" : "light";
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#1c1c1e" : "#ffffff");
  } catch {}
`;

const clientErrorBootstrap = `
  (() => {
    const report = (payload) => {
      try {
        fetch("/api/client-errors", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, userAgent: navigator.userAgent }),
          keepalive: true,
        }).catch(() => {});
      } catch {}
    };
    addEventListener("error", (event) => report({
      kind: "error",
      message: event.message || "Unknown client error",
      source: event.filename || "",
      line: event.lineno || null,
      column: event.colno || null,
      stack: event.error && event.error.stack ? String(event.error.stack) : "",
    }));
    addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      // A save that came too late while restored data is adopted (lib/adoption.ts); the page is reloading.
      if (reason && reason.name === "AdoptionWriteRefused") { event.preventDefault(); return; }
      report({
        kind: "unhandledrejection",
        message: reason && reason.message ? String(reason.message) : String(reason || "Unhandled rejection"),
        source: location.href,
        stack: reason && reason.stack ? String(reason.stack) : "",
      });
    });
  })();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="cs" suppressHydrationWarning>
      <body>
        <Script id="theme-bootstrap" strategy="beforeInteractive">
          {themeBootstrap}
        </Script>
        <Script id="client-error-bootstrap" strategy="beforeInteractive">
          {clientErrorBootstrap}
        </Script>
        <PWARegister />
        {children}
      </body>
    </html>
  );
}
