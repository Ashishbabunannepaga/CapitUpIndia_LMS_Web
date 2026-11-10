"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { friendlyError } from "@/lib/action-errors";
import { getSession } from "@/lib/auth";
import { appLeadsFeed } from "@/server/appfeed/feed";
import { handOffAppLead, listAppLeads } from "@/server/data/app-leads";

// Plain forms that come back to /admin/app-leads with a one-line result (?ok= or ?error=).

function done(result: { ok: string } | { error: string }): never {
  const params = new URLSearchParams("ok" in result ? { ok: result.ok } : { error: result.error });
  revalidatePath("/admin/app-leads");
  redirect(`/admin/app-leads?${params}`);
}

export async function handOffAppLeadAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");
  const agent = String(formData.get("agent") ?? "") || null;
  let result: { ok: string } | { error: string };
  try {
    const handed = await handOffAppLead(appLeadsFeed, session.ctx, session.actor, formData.get("id"), agent);
    result = {
      ok: `Created LMS lead #${handed.leadId}.` + (handed.duplicate ? " It matches an existing client name; check Duplicates." : ""),
    };
  } catch (error) {
    result = { error: friendlyError(error) };
  }
  done(result);
}

/** Read the app's feed again now rather than after the 1-minute cache. */
export async function refreshAppLeadsAction(): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");
  let result: { ok: string } | { error: string };
  try {
    const view = await listAppLeads(appLeadsFeed, session.ctx, session.actor, true);
    result = view.state === "error" ? { error: view.message } : { ok: "Read the app's leads again." };
  } catch (error) {
    result = { error: friendlyError(error) };
  }
  done(result);
}
