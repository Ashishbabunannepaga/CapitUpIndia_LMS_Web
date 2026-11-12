// Worker secrets: set with `wrangler secret put` or the Cloudflare dashboard
// in production, and in .dev.vars locally (see .dev.vars.example). They are
// not in wrangler.jsonc, so `wrangler types` does not list them.
interface CloudflareEnv {
  BETTER_AUTH_SECRET: string;
  /**
   * Public URL of the app. Not a secret: it is set under `vars` in
   * wrangler.jsonc, but declared here because cloudflare-env.d.ts predates it.
   */
  BETTER_AUTH_URL?: string;
  /** OpenAI API key for the AI features (src/lib/ai/openai.ts). Optional: without it they fall back to rules. */
  OPENAI_API_KEY?: string;
  /** One-time code that opens /setup for the first admin; remove it after setup. */
  SETUP_CODE?: string;
  /**
   * Shared with the CloudFront distribution in front of lms.capitupindia.com,
   * which sends it as x-origin-verify; see src/lib/client-ip.ts.
   */
  ORIGIN_VERIFY_SECRET?: string;
  /**
   * The read-only capitupindia.com/office account the Office portal page
   * signs in with; see src/server/office/portal.ts. Optional: without them
   * the page only links to the portal.
   */
  OFFICE_EMAIL?: string;
  OFFICE_PASSWORD?: string;
  /** Not a secret (a var): the office site's address, default https://capitupindia.com. */
  OFFICE_PORTAL_URL?: string;
  /**
   * Monitoring alerts (src/server/monitoring/alerts.ts, docs/monitoring.md).
   * All optional secrets; set the channels you use.
   */
  ALERT_NTFY_TOPIC?: string;
  ALERT_NTFY_SERVER?: string;
  ALERT_WEBHOOK_URL?: string;
  ALERT_TELEGRAM_BOT_TOKEN?: string;
  ALERT_TELEGRAM_CHAT_ID?: string;
  /** Optional var: the URL the monitor loads instead of <BETTER_AUTH_URL>/api/health. */
  MONITOR_URL?: string;
  /**
   * The deployed version's id, for /api/health ("version_metadata" in wrangler.jsonc).
   * Declared here, as `wrangler types` would, because cloudflare-env.d.ts predates it.
   */
  CF_VERSION_METADATA: WorkerVersionMetadata;
}
