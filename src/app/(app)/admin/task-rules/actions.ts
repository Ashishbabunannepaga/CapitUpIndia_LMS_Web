"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { friendlyError } from "@/lib/action-errors";
import { getSession } from "@/lib/auth";
import { deleteHoliday, deleteSlaRule, saveHoliday, saveSlaRule } from "@/server/data/task-rules";

const PAGE = "/admin/task-rules";

async function run(fn: (s: NonNullable<Awaited<ReturnType<typeof getSession>>>) => Promise<void>): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");
  let error: string | null = null;
  try {
    await fn(session);
  } catch (e) {
    error = friendlyError(e);
  }
  revalidatePath(PAGE);
  redirect(error ? `${PAGE}?error=${encodeURIComponent(error)}` : PAGE);
}

const hours = (v: FormDataEntryValue | null) => Math.round(Number(v ?? 0) * 60);

export async function saveSlaRuleAction(formData: FormData): Promise<void> {
  await run((s) =>
    saveSlaRule(s.ctx, s.actor, {
      tag: String(formData.get("tag") ?? ""),
      priority: String(formData.get("priority") ?? "") || null,
      soon_minutes: hours(formData.get("soon_hours")),
      nudge_minutes: hours(formData.get("nudge_hours")),
      escalate_minutes: hours(formData.get("escalate_hours")),
    }),
  );
}

export async function deleteSlaRuleAction(formData: FormData): Promise<void> {
  await run((s) => deleteSlaRule(s.ctx, s.actor, Number(formData.get("id"))));
}

export async function saveHolidayAction(formData: FormData): Promise<void> {
  await run((s) => saveHoliday(s.ctx, s.actor, String(formData.get("date") ?? ""), String(formData.get("name") ?? "")));
}

export async function deleteHolidayAction(formData: FormData): Promise<void> {
  await run((s) => deleteHoliday(s.ctx, s.actor, String(formData.get("date") ?? "")));
}
