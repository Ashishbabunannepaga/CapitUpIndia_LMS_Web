import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config";
import { SECURITY_HEADERS } from "../security-headers";

const header = (key: string) => SECURITY_HEADERS.find((h) => h.key === key)?.value ?? "";

describe("security headers", () => {
  it("are sent on every path", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([{ source: "/:path*", headers: SECURITY_HEADERS }]);
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("forbid framing, plugins, third-party scripts and off-site form posts", () => {
    const csp = header("Content-Security-Policy");
    for (const directive of [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toMatch(/https?:|\*/);
    expect(header("X-Frame-Options")).toBe("DENY");
  });

  it("pin HTTPS, stop MIME sniffing and limit the referrer", () => {
    expect(header("Strict-Transport-Security")).toMatch(/max-age=\d{8,}/);
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("allow the camera and microphone only on our own pages", () => {
    const policy = header("Permissions-Policy");
    expect(policy).toContain("camera=(self)");
    expect(policy).toContain("microphone=(self)");
    expect(policy).toContain("geolocation=()");
  });
});
