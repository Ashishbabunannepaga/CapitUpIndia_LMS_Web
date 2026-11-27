"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { applyAuthCookies, currentRequestInfo } from "@/lib/auth-cookies";
import { requireSessionForTwoFactorSetup } from "@/lib/auth";
import { confirmTwoFactorSetup, disableOwnTwoFactor, startTwoFactorSetup } from "@/server/data/sessions";
import { twoFactorRequired } from "@/server/data/users";

export type SetupState = {
  error?: string;
  /** Present once the password was right: what the app needs, shown once. */
  setup?: { totpURI: string; secret: string; backupCodes: string[] };
};

const cookieHeader = async () => (await headers()).get("cookie") ?? "";

/** Step 1: password, then a new secret and backup codes (nothing is switched on yet). */
export async function startSetup(prev: SetupState, formData: FormData): Promise<SetupState> {
  const { ctx } = await requireSessionForTwoFactorSetup();
  const password = String(formData.get("password") ?? "");
  if (!password) return { error: "Enter your password." };
  const setup = await startTwoFactorSetup(ctx, { password, cookie: await cookieHeader() }, await currentRequestInfo());
  if (!setup) return { error: "That password is wrong." };
  return { setup };
}

/** Step 2: the first code from the app switches two-step sign-in on. */
export async function confirmSetup(prev: SetupState, formData: FormData): Promise<SetupState> {
  const { ctx } = await requireSessionForTwoFactorSetup();
  const code = String(formData.get("code") ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return { ...prev, error: "Enter the 6-digit code from the app." };
  const result = await confirmTwoFactorSetup(ctx, { code, cookie: await cookieHeader() }, await currentRequestInfo());
  if (result.status === "rate-limited") return { ...prev, error: "Too many tries. Wait 10 seconds and enter the newest code." };
  if (result.status !== "ok") return { ...prev, error: "That code is wrong. Check the time on your phone and try the newest code." };
  applyAuthCookies(await cookies(), result.setCookies);
  redirect("/my-day?two_factor=on");
}

export type DisableState = { error?: string };

/** Agents may switch it off again; admins must keep it. */
export async function disableTwoFactor(_prev: DisableState, formData: FormData): Promise<DisableState> {
  const { ctx, actor } = await requireSessionForTwoFactorSetup();
  if (twoFactorRequired(actor)) return { error: "Admins must keep two-step sign-in on." };
  const password = String(formData.get("password") ?? "");
  if (!password) return { error: "Enter your password." };
  const setCookies = await disableOwnTwoFactor(ctx, { password, cookie: await cookieHeader() }, await currentRequestInfo());
  if (!setCookies) return { error: "That password is wrong." };
  applyAuthCookies(await cookies(), setCookies);
  redirect("/two-factor");
}
