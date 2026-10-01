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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="cs" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <PWARegister />
        {children}
      </body>
    </html>
  );
}
