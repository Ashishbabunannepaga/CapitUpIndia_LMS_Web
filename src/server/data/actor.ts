import "server-only";

import { eq } from "drizzle-orm";

import { profiles } from "../db/schema";
import { AccessDeniedError } from "./errors";
import type { DataContext } from "./context";

/** The signed-in, active user every data function acts for: their profile. */
export type Actor = typeof profiles.$inferSelect;

export type ActorResult = { status: "ok"; actor: Actor } | { status: "signed-out" } | { status: "inactive" };

/**
 * Who is making this request. A valid session is not enough: the profile must
 * exist and be active, so deactivating someone cuts them off on their next
 * request even though their session cookie is still valid.
 */
export async function resolveActor(ctx: DataContext, headers: Headers): Promise<ActorResult> {
  const session = await ctx.auth.api.getSession({ headers });
  if (!session) return { status: "signed-out" };
  const profile = await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, session.user.id) });
  if (!profile || !profile.is_active) return { status: "inactive" };
  return { status: "ok", actor: profile };
}

export function isAdmin(actor: Actor): boolean {
  return actor.role === "ADMIN";
}

export function assertAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw new AccessDeniedError("Only admins can do that.");
}
