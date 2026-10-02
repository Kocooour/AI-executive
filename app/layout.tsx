import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PWARegister } from "./pwa-register";

export const metadata: Metadata = {
  title: "AI Executive",
  description: "A calm personal workspace for tasks, projects and notes.",
  applicationName: "AI Executive",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "AI Executive",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f3f1",
};

const themeBootstrap = `
  try {
    const saved = localStorage.getItem("ai-executive-theme") || "system";
    const dark = saved === "dark" || (saved === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    const resolved = dark ? "dark" : "light";
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#1c1c1e" : "#f4f3f1");
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
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <script dangerouslySetInnerHTML={{ __html: clientErrorBootstrap }} />
      </head>
      <body>
        <PWARegister />
        {children}
      </body>
    </html>
  );
}
