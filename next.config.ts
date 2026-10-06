import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Sheet imports and visiting card photos are posted to server actions.
      // The default is 1 MB; Vercel rejects anything over 4.5 MB, so stay
      // just under it. Per-file limits live in src/lib/upload-limits.ts.
      bodySizeLimit: "4.4mb",
    },
  },
};

export default nextConfig;
