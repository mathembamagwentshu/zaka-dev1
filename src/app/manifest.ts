import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Zaka Lite",
    short_name: "Zaka",
    description: "Split one purchase across two cards, or between two people.",
    start_url: "/",
    display: "browser",
    background_color: "#f6f7f9",
    theme_color: "#f6f7f9",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
