"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { safeNextPath } from "@/lib/safe-redirect";
import { applyAuthCookies, currentRequestInfo } from "@/lib/auth-cookies";
import { getDataContext } from "@/server/data/context";
import { signInWithPassword, verifyTwoFactorSignIn } from "@/server/data/sessions";

const credentialsSchema = z.object({
  email: z.email("Enter a valid email address.").trim().toLowerCase(),
  password: z.string().min(1, "Enter your password."),
  next: z.string().optional(),
});

export type LoginState = { error?: string; email?: string };

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check your details.", email };
  }

  const ctx = await getDataContext();
  const result = await signInWithPassword(
    ctx,
    { email: parsed.data.email, password: parsed.data.password },
    await currentRequestInfo(),
  );
  switch (result.status) {
    case "invalid":
      // Same message for unknown email and wrong password.
      return { error: "Incorrect email or password.", email };
    case "rate-limited":
      return { error: "Too many sign-in attempts. Wait a minute and try again.", email };
    case "inactive":
      return { error: "Your account is disabled. Contact your administrator.", email };
  }

  applyAuthCookies(await cookies(), result.setCookies);
  if (result.status === "two-factor") {
    const next = safeNextPath(parsed.data.next);
    redirect(`/login/two-factor${next === "/my-day" ? "" : `?next=${encodeURIComponent(next)}`}`);
  }
  redirect(safeNextPath(parsed.data.next));
}

const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(6, "Enter the code.")
    .max(40, "That code is too long."),
  kind: z.enum(["totp", "backup"]).default("totp"),
  trust: z.string().optional(),
  next: z.string().optional(),
});

export type CodeState = { error?: string; expired?: boolean };

/** Second step of sign-in: the code from the authenticator app, or a backup code. */
export async function verifyCode(_prev: CodeState, formData: FormData): Promise<CodeState> {
  const parsed = codeSchema.safeParse({
    code: formData.get("code"),
    kind: formData.get("kind") ?? undefined,
    trust: formData.get("trust") ?? undefined,
    next: formData.get("next") ?? undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter the code." };

  const store = await cookies();
  const cookie = (await headers()).get("cookie") ?? "";
  const ctx = await getDataContext();
  const result = await verifyTwoFactorSignIn(
    ctx,
    { code: parsed.data.code, kind: parsed.data.kind, trustDevice: parsed.data.trust === "on", cookie },
    await currentRequestInfo(),
  );
  switch (result.status) {
    case "invalid":
      return { error: parsed.data.kind === "backup" ? "That backup code is wrong or already used." : "That code is wrong. Check the time on your phone and try the newest code." };
    case "expired":
      return { error: "This sign-in timed out. Enter your password again.", expired: true };
    case "rate-limited":
      return { error: "Too many tries. Wait a minute and try again." };
    case "inactive":
      return { error: "Your account is disabled. Contact your administrator.", expired: true };
  }
  applyAuthCookies(store, result.setCookies);
  redirect(safeNextPath(parsed.data.next));
}
