import { defineCloudflareConfig } from "@opennextjs/cloudflare";

const config = {
  ...defineCloudflareConfig(),
  // `next build` plus a fix to the proxy's file trace; see the script.
  buildCommand: "node scripts/next-build-for-cloudflare.mjs",
};

export default config;
