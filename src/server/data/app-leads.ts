import "server-only";

import { eq, inArray, isNotNull } from "drizzle-orm";

import { leads, profiles } from "../db/schema";
import type { AppFeedResult, AppLead, AppLeadsSource } from "../appfeed/feed";
import { assertAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";
import { createLead } from "./leads";

// Leads from the CapitUp client app: people who ticked "CapitUp may contact me".
//
// Data ownership, as with the Office: the app keeps its users and policies in
// its own database; the LMS reads the app's leads feed and copies nothing into
// D1 except the leads an admin hands to an agent (linked by app_user_id).
//
// Admins only: the list has names and phone numbers. When an app user
// withdraws consent or deletes their account, any LMS lead handed over from
// them gets a do-not-contact note and is moved to Closed Lost
// (applyAppWithdrawals, run on every page view and by the cron).

/** The marker that makes the withdrawal note idempotent. */
export const WITHDRAWN_MARKER = "[App] Do not contact:";

const PRODUCT: Record<string, "Health" | "Motor" | "Life"> = { health: "Health", motor: "Motor", life: "Life" };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AppLeadRow = AppLead & { handoff: { leadId: number; agentName: string | null } | null };

export type AppLeadsView =
  | { state: "ok"; fetchedAt: string; items: AppLeadRow[]; withdrawn: number }
  | { state: "not-configured" }
  | { state: "error"; message: string };

function inr(value: string | number | null | undefined): string | null {
  const n = Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? null : `Rs ${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** The LMS lead fields for an app user. App users are individuals, so Retail. */
export function leadFromApp(item: AppLead, today = new Date().toISOString().slice(0, 10)) {
  const policies = item.policies ?? [];
  // The policy to renew: the next expiry from today, else the latest one, else the first.
  const dated = policies.filter((p) => p.end_date).sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)));
  const policy = dated.find((p) => String(p.end_date) >= today) ?? dated[dated.length - 1] ?? policies[0];
  const name = (item.full_name ?? "").trim();
  const email = (item.email ?? "").trim();
  const policyLines = policies.map((p) =>
    [
      `- ${PRODUCT[p.policy_type] ?? "Other"}: ${[p.insurer, p.plan_name].filter(Boolean).join(", ") || "insurer not read"}`,
      p.end_date ? `ends ${p.end_date}` : null,
      inr(p.sum_insured) ? `cover ${inr(p.sum_insured)}` : null,
      inr(p.premium) ? `premium ${inr(p.premium)}` : null,
      p.verified ? null : "(not yet checked by the client)",
    ]
      .filter(Boolean)
      .join(", "),
  );
  const notes = [
    `From the CapitUp app: opted in to be contacted on ${String(item.contact_consent_at ?? "").slice(0, 10) || "unknown date"}` +
      (item.contact_consent_version ? ` (consent text ${item.contact_consent_version})` : "") +
      ". Contact only about their insurance; stop if they ask.",
    [item.city, item.state].filter(Boolean).length ? `Location: ${[item.city, item.state].filter(Boolean).join(", ")}` : null,
    policies.length ? `Policies in the app (${policies.length}):\n${policyLines.join("\n")}` : "No policies added in the app yet.",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    client_name: (name || item.phone || "App user").slice(0, 300),
    type: (policy?.end_date ? "Renewal" : "New") as "Renewal" | "New",
    business_type: "Retail" as const,
    policy_product: PRODUCT[policy?.policy_type ?? ""] ?? ("Health" as const),
    renewal_date: policy?.end_date ?? null,
    poc_name: name.slice(0, 120),
    poc_contact_number: (item.phone ?? "").trim().slice(0, 32),
    poc_email_id: EMAIL.test(email) ? email.slice(0, 200) : "",
    notes: notes.slice(0, 20000),
    status: "Prospect" as const,
  };
}

async function handoffs(ctx: DataContext, ids: string[]) {
  const map = new Map<string, { leadId: number; agentName: string | null }>();
  // D1 caps bound parameters per statement; look up in chunks.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await ctx.db
      .select({ id: leads.id, app_user_id: leads.app_user_id, agent: profiles.full_name })
      .from(leads)
      .leftJoin(profiles, eq(profiles.id, leads.assigned_agent_id))
      .where(inArray(leads.app_user_id, chunk));
    for (const r of rows) if (r.app_user_id) map.set(r.app_user_id, { leadId: r.id, agentName: r.agent ?? null });
  }
  return map;
}

/**
 * Marks LMS leads whose app user withdrew consent (or is deleting their account):
 * a do-not-contact note, status Closed Lost. Idempotent. Returns how many leads changed.
 */
export async function applyAppWithdrawals(ctx: DataContext, feed: AppFeedResult, actor: Actor | null = null): Promise<number> {
  if (feed.state !== "ok") return 0;
  const withdrawn = feed.items.filter((i) => i.status === "withdrawn" && ID.test(i.app_user_id));
  if (!withdrawn.length) return 0;
  const byId = new Map(withdrawn.map((i) => [i.app_user_id.toLowerCase(), i]));
  let changed = 0;
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await ctx.db.select().from(leads).where(inArray(leads.app_user_id, ids.slice(i, i + 90)));
    for (const lead of rows) {
      if (!lead.app_user_id || lead.notes.includes(WITHDRAWN_MARKER)) continue;
      const item = byId.get(lead.app_user_id)!;
      const when = String(item.withdrawn_at ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      const line = `${WITHDRAWN_MARKER} the client withdrew consent in the CapitUp app on ${when}. Do not call or message them.`;
      const notes = `${line}\n${lead.notes}`.slice(0, 20000);
      const stamp = new Date().toISOString();
      await ctx.db.batch([
        ctx.db.update(leads).set({ notes, status: "Closed Lost", updated_at: stamp }).where(eq(leads.id, lead.id)),
        auditInsert(ctx, actor, "leads", lead.id, "UPDATE", { status: lead.status }, { status: "Closed Lost", reason: "app_consent_withdrawn" }),
      ]);
      changed++;
    }
  }
  return changed;
}

/** Admins: the app's opted-in users, with whether each is already an LMS lead. */
export async function listAppLeads(source: AppLeadsSource, ctx: DataContext, actor: Actor, force = false): Promise<AppLeadsView> {
  assertAdmin(actor);
  const feed = await source.read(force);
  if (feed.state !== "ok") return feed;
  await applyAppWithdrawals(ctx, feed, actor);
  const active = feed.items.filter((i) => i.status === "active" && ID.test(i.app_user_id));
  const linked = await handoffs(ctx, active.map((i) => i.app_user_id.toLowerCase()));
  const items = active
    .map((i) => ({ ...i, handoff: linked.get(i.app_user_id.toLowerCase()) ?? null }))
    // Not yet handed over first, then the soonest renewal.
    .sort(
      (a, b) =>
        Number(Boolean(a.handoff)) - Number(Boolean(b.handoff)) ||
        String(a.next_renewal_date ?? "9999").localeCompare(String(b.next_renewal_date ?? "9999")),
    );
  return { state: "ok", fetchedAt: feed.fetchedAt, items, withdrawn: feed.items.length - active.length };
}

export type AppHandoffResult = { leadId: number; duplicate: boolean };

/** Admins: turn an opted-in app user into an LMS lead for an agent (or Unassigned). */
export async function handOffAppLead(
  source: AppLeadsSource,
  ctx: DataContext,
  actor: Actor,
  appUserId: unknown,
  agentId: string | null,
): Promise<AppHandoffResult> {
  assertAdmin(actor);
  if (typeof appUserId !== "string" || !ID.test(appUserId)) throw new InvalidInputError("That app lead link is not valid.");
  const id = appUserId.toLowerCase();
  const existing = await ctx.db.query.leads.findFirst({ where: eq(leads.app_user_id, id) });
  if (existing) throw new InvalidInputError(`This app user is already LMS lead #${existing.id}.`);
  const feed = await source.read();
  if (feed.state === "not-configured") throw new InvalidInputError("The app leads feed is not set up yet (APP_API_URL, APP_LEADS_TOKEN).");
  if (feed.state === "error") throw new InvalidInputError(feed.message);
  const item = feed.items.find((i) => i.app_user_id.toLowerCase() === id);
  if (!item || item.status !== "active") throw new InvalidInputError("This person is no longer opted in to be contacted.");
  const agent = agentId ? await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, agentId) }) : null;
  if (agentId && !agent?.is_active) throw new InvalidInputError("Pick an active team member.");

  let leadId: number;
  try {
    leadId = await createLead(ctx, actor, { ...leadFromApp(item), assigned_agent_id: agentId, app_user_id: id });
  } catch (error) {
    const text = String(error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : error);
    if (text.includes("leads_app_user_id_idx") || text.includes("UNIQUE")) {
      throw new InvalidInputError("This app user was just handed over by someone else.");
    }
    throw error;
  }
  const created = await ctx.db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  return { leadId, duplicate: Boolean(created?.is_duplicate) };
}

/** For the cron: apply withdrawals without an actor. */
export async function syncAppWithdrawals(source: AppLeadsSource, ctx: DataContext): Promise<number> {
  const linked = await ctx.db.select({ id: leads.id }).from(leads).where(isNotNull(leads.app_user_id)).limit(1);
  if (!linked.length) return 0; // nothing handed over yet: skip the network call
  return applyAppWithdrawals(ctx, await source.read());
}
