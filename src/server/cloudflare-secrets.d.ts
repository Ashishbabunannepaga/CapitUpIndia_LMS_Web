// Worker secrets: set with `wrangler secret put` or the Cloudflare dashboard
// in production, and in .dev.vars locally (see .dev.vars.example). They are
// not in wrangler.jsonc, so `wrangler types` does not list them.
interface CloudflareEnv {
  BETTER_AUTH_SECRET: string;
  /** Public URL of the app, e.g. https://lms.capitupindia.com. */
  BETTER_AUTH_URL?: string;
  GEMINI_API_KEY?: string;
}
