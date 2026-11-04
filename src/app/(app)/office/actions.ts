"use server";

import { revalidatePath } from "next/cache";

import { getSession } from "@/lib/auth";
import { refreshOffice } from "@/server/data/office";
import { officePortal } from "@/server/office/portal";

/** Admins: read the office portal again now rather than after the 5-minute cache. */
export async function refreshOfficeAction(): Promise<void> {
  const session = await getSession();
  if (!session) return;
  try {
    await refreshOffice(officePortal, session.actor);
  } catch {
    return; // agents cannot refresh; the button is admin-only anyway
  }
  revalidatePath("/office");
}
