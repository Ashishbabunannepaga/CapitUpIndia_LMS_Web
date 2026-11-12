import type { MetadataRoute } from "next";

// Lets people install the LMS on their phone's home screen. On iPhone this is
// also what makes push notifications possible (Safari only allows web push
// for sites added to the Home Screen).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CapitUp India LMS",
    short_name: "CapitUp LMS",
    description: "Leads, renewals and follow-ups for the CapitUp India team.",
    start_url: "/my-day",
    scope: "/",
    display: "standalone",
    background_color: "#082321",
    theme_color: "#082321",
    icons: [{ src: "/capitup-logo.png", sizes: "128x128", type: "image/png" }],
  };
}
