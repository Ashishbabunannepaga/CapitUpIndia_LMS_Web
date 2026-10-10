import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Sheet imports and visiting card photos are posted to server actions.
      // The default is 1 MB; keep it small since cards and sheets are
      // the only large uploads. Per-file limits live in src/lib/upload-limits.ts.
      bodySizeLimit: "4.4mb",
    },
  },
};

export default nextConfig;

// Gives `next dev` the D1 and R2 bindings from wrangler.jsonc (local copies).
initOpenNextCloudflareForDev();
