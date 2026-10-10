"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { safeNextPath } from "@/lib/safe-redirect";
import { applyAuthCookies, currentRequestInfo } from "@/lib/auth-cookies";
import { getDataContext } from "@/server/data/context";
import { signInWithPassword } from "@/server/data/sessions";

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
  redirect(safeNextPath(parsed.data.next));
}
