// Security headers sent with every page and route (next.config.ts).
//
// The CSP keeps scripts, styles, images and requests on our own origin.
// Next.js injects inline bootstrap scripts, and a nonce-based policy would
// force every page to render dynamically (more Worker CPU on the Free plan),
// so 'unsafe-inline' stays for scripts and styles; React's escaping is the
// main XSS defence and this policy is the second layer (no third-party
// scripts, no framing, no plugins, forms post only to us).
//
// Static files under /_next/static are served by the Workers assets binding
// before Next.js runs, so they do not get these headers; they are immutable
// JS/CSS/images with no user data.

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Visiting card previews use blob: and data: URLs.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "Content-Security-Policy", value: csp },
  // Two years, all subdomains of the app's host. Browsers ignore it over http.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera for visiting card capture and microphone for spoken AI intake,
  // both on our own pages only; everything else off.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];
