"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { friendlyError } from "@/lib/action-errors";
import { getSession } from "@/lib/auth";
import { handOffCallRequest, refreshOffice, updateCallRequest, updateOfficeRenewal } from "@/server/data/office";
import { officePortal } from "@/server/office/portal";

// Office forms post here and come back to the page they were on, with a
// one-line result (?ok= or ?error=). Plain forms: no client JavaScript needed.

function back(formData: FormData): URL {
  const raw = String(formData.get("back") ?? "");
  // Only ever return to the Office page itself.
  const url = new URL(raw.startsWith("/office") ? raw : "/office", "http://lms.local");
  url.searchParams.delete("ok");
  url.searchParams.delete("error");
  return url;
}

function done(url: URL, result: { ok: string } | { error: string }): never {
  if ("ok" in result) url.searchParams.set("ok", result.ok);
  else url.searchParams.set("error", result.error);
  revalidatePath("/office");
  redirect(`${url.pathname}${url.search}`);
}

function text(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

/** Admins: read the office portal again now rather than after the 5-minute cache. */
export async function refreshOfficeAction(formData: FormData): Promise<void> {
  const url = back(formData);
  const session = await getSession();
  if (!session) redirect("/login");
  let result: { ok: string } | { error: string };
  try {
    await refreshOffice(officePortal, session.actor);
    result = { ok: "Read the office portal again." };
  } catch (error) {
    result = { error: friendlyError(error) };
  }
  done(url, result);
}

export async function updateCallRequestAction(formData: FormData): Promise<void> {
  const url = back(formData);
  const session = await getSession();
  if (!session) redirect("/login");
  const status = text(formData, "status");
  const notes = text(formData, "notes");
  let result: { ok: string } | { error: string };
  try {
    await updateCallRequest(officePortal, session.ctx, session.actor, text(formData, "id"), {
      ...(status ? { status } : {}),
      ...(notes !== undefined ? { notes } : {}),
    });
    result = { ok: status ? "Follow-up status saved." : "Notes saved." };
  } catch (error) {
    result = { error: friendlyError(error) };
  }
  done(url, result);
}

export async function handOffAction(formData: FormData): Promise<void> {
  const url = back(formData);
  const session = await getSession();
  if (!session) redirect("/login");
  const agent = text(formData, "agent") || null;
  let result: { ok: string } | { error: string };
  try {
    const handed = await handOffCallRequest(officePortal, session.ctx, session.actor, text(formData, "id"), agent);
    result = {
      ok:
        `Created LMS lead #${handed.leadId}.` +
        (handed.duplicate ? " It matches an existing company; check Duplicates." : "") +
        (handed.officeNoted ? "" : " The office note could not be added."),
    };
    revalidatePath("/", "layout");
  } catch (error) {
    result = { error: friendlyError(error) };
  }
  done(url, result);
}

export async function updateRenewalAction(formData: FormData): Promise<void> {
  const url = back(formData);
  const session = await getSession();
  if (!session) redirect("/login");
  const change: Record<string, string> = {};
  for (const key of ["renewal_status", "renewal_note", "expires_on"] as const) {
    const value = text(formData, key);
    if (value !== undefined && (key === "renewal_note" || value)) change[key] = value;
  }
  let result: { ok: string } | { error: string };
  try {
    await updateOfficeRenewal(officePortal, session.ctx, session.actor, text(formData, "id"), change);
    result = { ok: change.expires_on ? "End date corrected." : change.renewal_status ? "Renewal status saved." : "Renewal note saved." };
  } catch (error) {
    result = { error: friendlyError(error) };
  }
  done(url, result);
}
