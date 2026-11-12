// The Worker entry point: the Next.js app built by OpenNext, plus the
// Cron Trigger from wrangler.jsonc. It imports the build output, so it is
// left out of tsconfig.json and checked by `wrangler deploy --dry-run` in CI.
import app from "./.open-next/worker.js";

import { recordFailedRequest } from "./src/worker/errors";
import { runScheduled } from "./src/worker/scheduled";

export default {
  // Every 5xx (or thrown error) is recorded for the monitor after the
  // response has gone out, so it never slows a page down.
  async fetch(request, env, ctx) {
    try {
      const response = await app.fetch(request, env, ctx);
      if (response.status >= 500) ctx.waitUntil(recordFailedRequest(env, request, response.status));
      return response;
    } catch (error) {
      ctx.waitUntil(recordFailedRequest(env, request, 500, error));
      throw error;
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<CloudflareEnv>;

export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
