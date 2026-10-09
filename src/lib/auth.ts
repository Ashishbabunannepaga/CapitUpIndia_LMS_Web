import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { Profile } from "@/lib/database.types";
import { resolveActor, type Actor, type ActorResult } from "@/server/data/actor";
import { getDataContext, type DataContext } from "@/server/data/context";

/** The data context and who is asking, resolved once per request. */
const resolveRequest = cache(async (): Promise<{ ctx: DataContext; result: ActorResult }> => {
  // Reading the headers first also marks every signed-in page as dynamic.
  const requestHeaders = await headers();
  const ctx = await getDataContext();
  return { ctx, result: await resolveActor(ctx, requestHeaders) };
});

/** The signed-in, active user's profile, or null. Cached for one request. */
export const getCurrentProfile = cache(async (): Promise<Profile | null> => {
  const { result } = await resolveRequest();
  return result.status === "ok" ? result.actor : null;
});

/** Requires an active signed-in user; otherwise redirects to /login. */
export async function requireProfile(): Promise<Profile> {
  return (await requireSession()).actor;
}

/** Requires an active ADMIN; agents are sent back to My Day. */
export async function requireAdmin(): Promise<Profile> {
  const profile = await requireProfile();
  if (profile.role !== "ADMIN") {
    redirect("/my-day");
  }
  return profile;
}

export type Session = { ctx: DataContext; actor: Actor };

/** For pages: the data context and active user, or a redirect to sign in. */
export async function requireSession(): Promise<Session> {
  const { ctx, result } = await resolveRequest();
  if (result.status === "ok") return { ctx, actor: result.actor };
  redirect(result.status === "inactive" ? "/auth/signout?reason=inactive" : "/login");
}

/** For server actions: the data context and active user, or null when signed out or inactive. */
export async function getSession(): Promise<Session | null> {
  const { ctx, result } = await resolveRequest();
  return result.status === "ok" ? { ctx, actor: result.actor } : null;
}

export function isAdmin(profile: Pick<Profile, "role">): boolean {
  return profile.role === "ADMIN";
}
