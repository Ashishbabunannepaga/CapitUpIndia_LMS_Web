"use server";

import { revalidatePath } from "next/cache";

import { friendlyError } from "@/lib/action-errors";
import { getSession, type Session } from "@/lib/auth";
import { createUser, resetPassword, setActive, setRole } from "@/server/data/users";

export type TeamResult = { ok: true; message?: string } | { ok: false; error: string };

// Admin-only account management. The data layer checks the caller is an
// active admin and keeps at least one active admin; these only translate.

async function run(fn: (session: Session) => Promise<unknown>, message?: string): Promise<TeamResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Your session has ended. Sign in again." };
  try {
    await fn(session);
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  revalidatePath("/", "layout");
  return { ok: true, message };
}

export async function addTeamMember(formData: FormData): Promise<TeamResult> {
  const input = {
    fullName: formData.get("full_name") ?? "",
    email: formData.get("email") ?? "",
    password: formData.get("password") ?? "",
    role: formData.get("role") || "AGENT",
  };
  return run(({ ctx, actor }) => createUser(ctx, actor, input), "Account created. Share the password with them in person.");
}

export async function changeMemberRole(userId: string, role: string): Promise<TeamResult> {
  return run(({ ctx, actor }) => setRole(ctx, actor, userId, role));
}

export async function changeMemberActive(userId: string, active: boolean): Promise<TeamResult> {
  return run(({ ctx, actor }) => setActive(ctx, actor, userId, active));
}

export async function resetMemberPassword(userId: string, formData: FormData): Promise<TeamResult> {
  return run(
    ({ ctx, actor }) => resetPassword(ctx, actor, userId, formData.get("password") ?? ""),
    "Password changed. They have been signed out everywhere.",
  );
}
