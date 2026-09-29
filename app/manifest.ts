import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AI Executive",
    short_name: "Executive",
    description: "A calm personal workspace for tasks, projects and notes.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f8f8fb",
    theme_color: "#6557e8",
    orientation: "any",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
