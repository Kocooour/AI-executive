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
  themeColor: "#6557e8",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="cs">
      <body>
        <PWARegister />
        {children}
      </body>
    </html>
  );
}
