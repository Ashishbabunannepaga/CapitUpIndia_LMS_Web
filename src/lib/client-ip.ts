// The visitor's IP when the app is reached through AWS CloudFront
// (lms.capitupindia.com while DNS stays on cPanel). Cloudflare then sees
// CloudFront's address in cf-connecting-ip, so every user would share one
// sign-in rate limit. CloudFront sends the real address in
// CloudFront-Viewer-Address, and a secret header proves the request came
// through our distribution, so the header cannot be forged on workers.dev.

/** The IP from a CloudFront-Viewer-Address value ("1.2.3.4:5678" or "2001:db8::1:5678"). */
export function viewerAddressIp(value: string | null): string | null {
  if (!value) return null;
  const cut = value.lastIndexOf(":");
  const ip = (cut > 0 ? value.slice(0, cut) : value).replace(/^\[|\]$/g, "").trim();
  return /^[0-9a-fA-F:.]+$/.test(ip) && ip.length <= 45 ? ip : null;
}

/** Constant-time string comparison, so the secret can't be guessed byte by byte. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The client IP to use instead of cf-connecting-ip, or null to keep it. Only
 * requests carrying the CloudFront origin secret are trusted.
 */
export function proxiedClientIp(headers: Headers, secret: string | undefined): string | null {
  if (!secret || secret.length < 32) return null;
  const sent = headers.get("x-origin-verify");
  if (!sent || !sameSecret(sent, secret)) return null;
  return viewerAddressIp(headers.get("cloudfront-viewer-address"));
}
