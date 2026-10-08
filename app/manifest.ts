import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lumi",
    short_name: "Lumi",
    description: "A proactive personal AI Executive for tasks, projects and context.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f8f8fb",
    theme_color: "#6557e8",
    orientation: "any",
    icons: [
      { src: "/icons/lumi-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      {
        src: "/icons/lumi-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
