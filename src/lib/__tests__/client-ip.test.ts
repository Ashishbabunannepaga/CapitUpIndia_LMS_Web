import { describe, expect, it } from "vitest";

import { proxiedClientIp, viewerAddressIp } from "@/lib/client-ip";

const SECRET = "s".repeat(40);

describe("client IP behind CloudFront", () => {
  it("reads IPv4 and IPv6 viewer addresses", () => {
    expect(viewerAddressIp("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(viewerAddressIp("2001:db8::1:51234")).toBe("2001:db8::1");
    expect(viewerAddressIp("not an ip:1")).toBeNull();
    expect(viewerAddressIp(null)).toBeNull();
  });

  it("trusts the viewer address only with the origin secret", () => {
    const h = (extra: Record<string, string>) =>
      new Headers({ "cloudfront-viewer-address": "203.0.113.7:443", ...extra });
    expect(proxiedClientIp(h({ "x-origin-verify": SECRET }), SECRET)).toBe("203.0.113.7");
    expect(proxiedClientIp(h({ "x-origin-verify": "wrong" }), SECRET)).toBeNull();
    expect(proxiedClientIp(h({}), SECRET)).toBeNull();
    // No secret configured (or a short one): never trust the header.
    expect(proxiedClientIp(h({ "x-origin-verify": "" }), "")).toBeNull();
    expect(proxiedClientIp(h({ "x-origin-verify": "short" }), "short")).toBeNull();
  });
});
