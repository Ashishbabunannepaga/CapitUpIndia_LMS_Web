"use server";

import { revalidatePath } from "next/cache";

import { friendlyError } from "@/lib/action-errors";
import { getSession, type Session } from "@/lib/auth";
import { setStaleDays } from "@/server/data/stale";
import { createUser, deactivateUser, offboardingSummary, resetPassword, setActive, setRole, type Handover } from "@/server/data/users";

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
  return run(({ ctx, actor }) => createUser(ctx, actor, input), "Account created. Share the password with them in person; they will choose their own when they first sign in.");
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
    "Password changed. They have been signed out everywhere and will choose their own at next sign-in.",
  );
}

/** The stale-lead threshold in days (Team page). */
export async function changeStaleDays(days: number): Promise<TeamResult> {
  return run(({ ctx, actor }) => setStaleDays(ctx, actor, Number(days)), `Leads with no activity for ${days} days are now flagged stale.`);
}

/** How many leads and open tasks someone holds (asked before disabling them). */
export async function memberBook(userId: string): Promise<{ ok: true; leads: number; tasks: number } | { ok: false; error: string }> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Your session has ended. Sign in again." };
  try {
    return { ok: true, ...(await offboardingSummary(session.ctx, session.actor, userId)) };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

/**
 * Disables someone after handing over their leads and open tasks:
 * `to` is a team member's id, "unassigned" for the Unassigned pool, or
 * "skip" to leave everything with them (admin override).
 */
export async function disableMember(userId: string, to: string): Promise<TeamResult> {
  const handover: Handover = to === "skip" ? "skip" : { to: to === "unassigned" ? null : to };
  let moved = { leads: 0, tasks: 0 };
  const result = await run(async ({ ctx, actor }) => {
    moved = await deactivateUser(ctx, actor, userId, handover);
  });
  if (!result.ok) return result;
  const what = moved.leads || moved.tasks ? ` Moved ${moved.leads} lead${moved.leads === 1 ? "" : "s"} and ${moved.tasks} open task${moved.tasks === 1 ? "" : "s"}.` : "";
  return { ok: true, message: `Disabled and signed out.${what}` };
}
