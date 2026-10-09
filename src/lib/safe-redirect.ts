// Where to send someone after signing in. Only paths inside this app are
// allowed: "//evil.com", "/\evil.com" and "https://evil.com" all resolve to
// another site in a browser, so they fall back to My Day.

const BASE = "http://app.invalid";

export function safeNextPath(next: string | null | undefined, fallback = "/my-day"): string {
  if (!next || !next.startsWith("/")) return fallback;
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE || url.pathname.startsWith("/login")) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
