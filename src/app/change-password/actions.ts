"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { friendlyError } from "@/lib/action-errors";
import { requireSessionForPasswordChange } from "@/lib/auth";
import { changeOwnPassword } from "@/server/data/users";

export type ChangePasswordState = { error?: string };

export async function changePassword(_prev: ChangePasswordState, formData: FormData): Promise<ChangePasswordState> {
  const { ctx, actor } = await requireSessionForPasswordChange();
  const newPassword = String(formData.get("new_password") ?? "");
  if (newPassword !== String(formData.get("confirm_password") ?? "")) {
    return { error: "The two new passwords don't match." };
  }
  try {
    const current = await ctx.auth.api.getSession({ headers: await headers() });
    await changeOwnPassword(
      ctx,
      actor,
      { currentPassword: formData.get("current_password") ?? "", newPassword },
      current?.session.token ?? null,
    );
  } catch (error) {
    return { error: friendlyError(error) };
  }
  redirect("/my-day");
}
