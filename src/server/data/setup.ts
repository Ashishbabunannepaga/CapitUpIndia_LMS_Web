import "server-only";

import { count } from "drizzle-orm";

import { profiles } from "../db/schema";
import type { DataContext } from "./context";
import { AccessDeniedError } from "./errors";
import { createFirstAdmin, type TeamMember } from "./users";

// First-run setup: the first admin on a new deployment. Open only while the
// team is empty AND the SETUP_CODE Worker secret is set; the person must type
// that code, so finding the URL before the owner does is not enough.

export async function isSetupOpen(ctx: DataContext, setupCode: string | undefined): Promise<boolean> {
  if (!setupCode) return false;
  const [{ total }] = await ctx.db.select({ total: count() }).from(profiles);
  return total === 0;
}

function sameText(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export async function completeSetup(
  ctx: DataContext,
  setupCode: string | undefined,
  input: { code: unknown; email: unknown; fullName: unknown; password: unknown },
): Promise<TeamMember> {
  if (!setupCode || setupCode.length < 12) throw new AccessDeniedError("Setup is closed.");
  if (typeof input.code !== "string" || !sameText(input.code.trim(), setupCode)) {
    throw new AccessDeniedError("That setup code is not right.");
  }
  return createFirstAdmin(ctx, { email: input.email, fullName: input.fullName, password: input.password });
}
