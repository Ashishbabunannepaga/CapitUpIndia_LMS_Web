"use server";

import { revalidatePath } from "next/cache";

import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/** Marks one notification, or all of the user's, as read. RLS limits this to their own. */
export async function markNotificationsRead(id?: number): Promise<void> {
  await requireProfile();
  const supabase = await createClient();
  let query = supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
  if (id !== undefined) query = query.eq("id", id);
  await query;
  revalidatePath("/", "layout");
}
