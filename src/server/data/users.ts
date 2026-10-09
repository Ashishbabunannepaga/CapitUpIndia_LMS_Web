import "server-only";

import { asc, count, eq } from "drizzle-orm";
import { z } from "zod";

import { profiles } from "../db/schema";
import { assertAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";
import { AccessDeniedError, InvalidInputError, isTriggerError } from "./errors";

// Team accounts. Ported from the profiles rules in the Supabase migrations:
//   * every active user can see the team list;
//   * a user can change their own display name, nothing else about themselves;
//   * only admins create accounts, change roles, deactivate or reset passwords;
//   * there is always at least one active admin (also a D1 trigger).

const LAST_ADMIN = "The last active admin cannot be removed";

const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters for the password.")
  .max(128, "Use at most 128 characters for the password.");
const fullNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .transform((name) => name.slice(0, 120));

export const newUserSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")),
  fullName: fullNameSchema,
  role: z.enum(["ADMIN", "AGENT"]).default("AGENT"),
  password: passwordSchema,
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new InvalidInputError(result.error.issues[0]?.message ?? "Check the details.");
  return result.data;
}

export type TeamMember = typeof profiles.$inferSelect;

// Every active user may see the team; `actor` proves the caller was resolved.
export async function listTeam(ctx: DataContext, actor: Actor): Promise<TeamMember[]> {
  void actor;
  return ctx.db.select().from(profiles).orderBy(asc(profiles.fullName));
}

export async function listActiveAgents(ctx: DataContext, actor: Actor): Promise<Pick<TeamMember, "id" | "fullName">[]> {
  void actor;
  const rows = await ctx.db
    .select({ id: profiles.id, fullName: profiles.fullName, role: profiles.role, isActive: profiles.isActive })
    .from(profiles)
    .orderBy(asc(profiles.fullName));
  return rows.filter((r) => r.isActive && r.role === "AGENT").map(({ id, fullName }) => ({ id, fullName }));
}

/** Creates a sign-in account and its profile. Admins only. */
export async function createUser(ctx: DataContext, actor: Actor, input: unknown): Promise<TeamMember> {
  assertAdmin(actor);
  const data = parse(newUserSchema, input);
  const auth = await ctx.auth.$context;

  if (await auth.internalAdapter.findUserByEmail(data.email)) {
    throw new InvalidInputError("Someone on the team already uses that email.");
  }
  const user = await auth.internalAdapter.createUser(
    { email: data.email, name: data.fullName, emailVerified: true },
    { method: "admin" },
  );
  try {
    await auth.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await auth.password.hash(data.password),
    });
    const [profile] = await ctx.db
      .insert(profiles)
      .values({ id: user.id, email: data.email, fullName: data.fullName, role: data.role })
      .returning();
    return profile;
  } catch (error) {
    // D1 has no transaction across these writes; undo the half-made account.
    await auth.internalAdapter.deleteUser(user.id);
    throw error;
  }
}

/**
 * The first account on a new deployment, made an admin. Only works while the
 * team is empty, so it cannot be used to add a second admin later.
 */
export async function createFirstAdmin(ctx: DataContext, input: unknown): Promise<TeamMember> {
  const [{ total }] = await ctx.db.select({ total: count() }).from(profiles);
  if (total > 0) throw new AccessDeniedError("This app is already set up. Ask an admin for an account.");
  const data = parse(newUserSchema, input);
  const bootstrap: Actor = { id: "setup", email: "", fullName: "Setup", role: "ADMIN" };
  return createUser(ctx, bootstrap, { ...data, role: "ADMIN" });
}

/** Sets a new password and signs the user out everywhere. Admins only. */
export async function resetPassword(ctx: DataContext, actor: Actor, userId: string, password: unknown): Promise<void> {
  assertAdmin(actor);
  const value = parse(passwordSchema, password);
  const auth = await ctx.auth.$context;
  await findMember(ctx, userId);
  await auth.internalAdapter.updatePassword(userId, await auth.password.hash(value));
  await auth.internalAdapter.deleteUserSessions(userId);
}

/** Activates or deactivates an account. Deactivating signs them out. Admins only. */
export async function setActive(ctx: DataContext, actor: Actor, userId: string, active: boolean): Promise<void> {
  assertAdmin(actor);
  await findMember(ctx, userId);
  try {
    await ctx.db.update(profiles).set({ isActive: active }).where(eq(profiles.id, userId));
  } catch (error) {
    if (isTriggerError(error, LAST_ADMIN)) throw new AccessDeniedError("Keep at least one active admin.");
    throw error;
  }
  if (!active) await (await ctx.auth.$context).internalAdapter.deleteUserSessions(userId);
}

export async function setRole(ctx: DataContext, actor: Actor, userId: string, role: unknown): Promise<void> {
  assertAdmin(actor);
  const value = parse(z.enum(["ADMIN", "AGENT"], "Pick a role."), role);
  await findMember(ctx, userId);
  try {
    await ctx.db.update(profiles).set({ role: value }).where(eq(profiles.id, userId));
  } catch (error) {
    if (isTriggerError(error, LAST_ADMIN)) throw new AccessDeniedError("Keep at least one active admin.");
    throw error;
  }
}

/** Display name: users may change their own; admins anyone's. */
export async function renameUser(ctx: DataContext, actor: Actor, userId: string, fullName: unknown): Promise<void> {
  if (actor.id !== userId) assertAdmin(actor);
  const value = parse(fullNameSchema, fullName);
  await findMember(ctx, userId);
  await ctx.db.update(profiles).set({ fullName: value }).where(eq(profiles.id, userId));
}

async function findMember(ctx: DataContext, userId: string): Promise<TeamMember> {
  const member = await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, userId) });
  if (!member) throw new InvalidInputError("That team member does not exist.");
  return member;
}
