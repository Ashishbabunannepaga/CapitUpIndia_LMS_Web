// The Worker entry point: the Next.js app built by OpenNext, plus the
// Cron Trigger from wrangler.jsonc. It imports the build output, so it is
// left out of tsconfig.json and checked by `wrangler deploy --dry-run` in CI.
import app from "./.open-next/worker.js";

import { runScheduled } from "./src/worker/scheduled";

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<CloudflareEnv>;

export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
