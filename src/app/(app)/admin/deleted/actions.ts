"use server";

import { revalidatePath } from "next/cache";

import { friendlyError } from "@/lib/action-errors";
import { getSession } from "@/lib/auth";
import { restoreDeletedLead } from "@/server/data/data-safety";

export type RestoreResult = { ok: true; leadId: number } | { ok: false; error: string };

/** Puts a deleted lead back (restoreDeletedLead allows admins only). */
export async function restoreLead(leadId: number): Promise<RestoreResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Your session has ended. Sign in again." };
  try {
    const id = await restoreDeletedLead(session.ctx, session.actor, leadId);
    revalidatePath("/", "layout");
    return { ok: true, leadId: id };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}
