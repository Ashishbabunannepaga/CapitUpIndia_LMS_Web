"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { redirect } from "next/navigation";

import { friendlyError } from "@/lib/action-errors";
import { getDataContext } from "@/server/data/context";
import { completeSetup } from "@/server/data/setup";

export type SetupState = { error?: string; email?: string; fullName?: string };

export async function setUp(_prev: SetupState, formData: FormData): Promise<SetupState> {
  const { env } = await getCloudflareContext({ async: true });
  const email = String(formData.get("email") ?? "");
  const fullName = String(formData.get("full_name") ?? "");
  try {
    await completeSetup(await getDataContext(), env.SETUP_CODE, {
      code: formData.get("code"),
      email,
      fullName,
      password: formData.get("password"),
    });
  } catch (error) {
    return { error: friendlyError(error), email, fullName };
  }
  redirect("/login?setup=done");
}
