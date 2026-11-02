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
  GEMINI_API_KEY?: string;
  /** One-time code that opens /setup for the first admin; remove it after setup. */
  SETUP_CODE?: string;
  /**
   * Shared with the CloudFront distribution in front of lms.capitupindia.com,
   * which sends it as x-origin-verify; see src/lib/client-ip.ts.
   */
  ORIGIN_VERIFY_SECRET?: string;
}
