"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { friendlyError } from "@/lib/action-errors";
import { getSession } from "@/lib/auth";
import { addPlaybookStep, createPlaybook, deletePlaybook, deletePlaybookStep, setPlaybookActive } from "@/server/data/playbooks";

const PAGE = "/admin/playbooks";

async function run(fn: (s: NonNullable<Awaited<ReturnType<typeof getSession>>>) => Promise<unknown>): Promise<void> {
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

const num = (v: FormDataEntryValue | null) => Number(v ?? NaN);
const str = (v: FormDataEntryValue | null) => String(v ?? "");

export async function createPlaybookAction(formData: FormData): Promise<void> {
  await run((s) => createPlaybook(s.ctx, s.actor, str(formData.get("name")), str(formData.get("applies_to"))));
}

export async function togglePlaybookAction(formData: FormData): Promise<void> {
  await run((s) => setPlaybookActive(s.ctx, s.actor, num(formData.get("id")), formData.get("active") === "on"));
}

export async function deletePlaybookAction(formData: FormData): Promise<void> {
  await run((s) => deletePlaybook(s.ctx, s.actor, num(formData.get("id"))));
}

export async function addStepAction(formData: FormData): Promise<void> {
  await run((s) =>
    addPlaybookStep(s.ctx, s.actor, num(formData.get("playbook_id")), {
      day_offset: num(formData.get("day_offset")),
      title: str(formData.get("title")),
      description: str(formData.get("description")),
      priority: str(formData.get("priority")),
      tags: str(formData.get("tags")),
    }),
  );
}

export async function deleteStepAction(formData: FormData): Promise<void> {
  await run((s) => deletePlaybookStep(s.ctx, s.actor, num(formData.get("id"))));
}
