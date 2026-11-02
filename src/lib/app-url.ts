// The app's public address is BETTER_AUTH_URL (wrangler.jsonc), now
// https://lms.capitupindia.com. That address reaches the Worker through AWS
// CloudFront, which sends the workers.dev Host header, so request.url says
// workers.dev even for visitors on lms. Build redirects from the public
// address instead, and send anyone who opens workers.dev directly to it.

/** An absolute URL on the app's public address (falls back to the request's own). */
export function publicUrl(path: string, requestUrl: string): URL {
  return new URL(path, process.env.BETTER_AUTH_URL || requestUrl);
}

/**
 * Where to send a visitor who opened the workers.dev address directly, or
 * null. Requests through CloudFront carry X-Amz-Cf-Id and are left alone.
 * Only GET and HEAD move, so a form posted from an old tab still goes through.
 */
export function workersDevRedirect(method: string, requestUrl: string, headers: Headers): URL | null {
  const base = process.env.BETTER_AUTH_URL;
  if (!base || (method !== "GET" && method !== "HEAD")) return null;
  const current = new URL(requestUrl);
  if (!current.hostname.endsWith(".workers.dev") || headers.has("x-amz-cf-id")) return null;
  const target = new URL(`${current.pathname}${current.search}`, base);
  return target.host === current.host ? null : target;
}
