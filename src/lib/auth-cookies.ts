import "server-only";

import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import type { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import { headers } from "next/headers";

import type { RequestInfo } from "@/server/data/sessions";

/** The origin, client IP and user agent of the current request, for the auth handler. */
export async function currentRequestInfo(): Promise<RequestInfo> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return {
    origin: process.env.BETTER_AUTH_URL || `${proto}://${host}`,
    ip: h.get("cf-connecting-ip"),
    userAgent: h.get("user-agent"),
  };
}

/** Copies Better Auth's Set-Cookie headers onto Next's response cookies. */
export function applyAuthCookies(store: Pick<ReadonlyRequestCookies, "set">, setCookies: string[]) {
  for (const header of setCookies) {
    for (const [name, attributes] of parseSetCookieHeader(header)) {
      store.set(name, attributes.value, toCookieOptions(attributes));
    }
  }
}
