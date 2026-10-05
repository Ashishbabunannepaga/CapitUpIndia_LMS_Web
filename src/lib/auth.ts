import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import type { Profile } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

/**
 * The signed-in user's profile, verified with the Supabase Auth server.
 * Returns null when signed out. Cached for the duration of one request.
 */
export const getCurrentProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  // RLS hides every profile from inactive users, so a missing row means
  // the account is disabled (or not provisioned yet).
  return profile ?? null;
});

/** Requires an active signed-in user; otherwise redirects to /login. */
export async function requireProfile(): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    redirect(user ? "/auth/signout?reason=inactive" : "/login");
  }
  return profile;
}

/** Requires an active ADMIN; agents are sent back to My Day. */
export async function requireAdmin(): Promise<Profile> {
  const profile = await requireProfile();
  if (profile.role !== "ADMIN") {
    redirect("/my-day");
  }
  return profile;
}

export function isAdmin(profile: Pick<Profile, "role">): boolean {
  return profile.role === "ADMIN";
}
