import "server-only";

import { businessDateTimeToIso } from "@/lib/dates";
import { isOneTimeProduct } from "@/lib/domain";

// Renewal countdown events for a lead, as the renewal-milestones migration
// generated them: one "DUE" event at the due time on the renewal date, and a
// background reminder at each offset before it that is still in the future.

export type MilestoneOffset = { milestone: string; offset_seconds: number };

type LeadForMilestones = {
  client_name: string;
  policy_product: string;
  renewal_date: string | null;
  assigned_agent_id: string | null;
  status?: string;
};

/**
 * What a lead's renewal date puts on the calendar: nothing (no date, or a
 * one-time product such as Travel), one "Auto-renews" entry with no countdown
 * (Auto Renewed term life), or the due date with the full countdown.
 */
export type RenewalMode = "none" | "auto" | "full";

export function renewalMode(lead: Pick<LeadForMilestones, "renewal_date" | "policy_product" | "status">): RenewalMode {
  if (!lead.renewal_date || isOneTimeProduct(lead.policy_product)) return "none";
  return lead.status === "Auto Renewed" ? "auto" : "full";
}

/**
 * Milestone of a kept due-date entry: when a policy year closes, its due
 * date stays on the calendar as a completed entry ("DONE 2026-11-05") instead
 * of being deleted, so the year leaves a trace.
 */
export const DONE_MILESTONE_PREFIX = "DONE ";

/** "Acme (Health)", or just "Acme" while the product is Not Specified (it says nothing useful in a title). */
export function clientWithProduct(clientName: string, product: string): string {
  return product && product !== "Not Specified" ? `${clientName} (${product})` : clientName;
}

export function renewalEventTitle(milestone: string, clientName: string, product: string, mode: RenewalMode = "full"): string {
  const who = clientWithProduct(clientName, product);
  const due = mode === "auto" ? `Auto-renews: ${who}` : `Renewal due: ${who}`;
  const title = milestone === "DUE" ? due : `${milestone} renewal reminder: ${who}`;
  return title.slice(0, 300);
}

/** The events a lead's renewal date implies right now (none without a date). */
export function milestoneEvents(
  lead: LeadForMilestones,
  offsets: MilestoneOffset[],
  dueTime: string,
  now: Date = new Date(),
) {
  const mode = renewalMode(lead);
  if (mode === "none" || !lead.renewal_date) return [];
  const due = new Date(businessDateTimeToIso(lead.renewal_date, dueTime));
  const base = {
    is_system_generated: true,
    assigned_agent_id: lead.assigned_agent_id,
    created_by: null,
  };
  return [
    {
      ...base,
      milestone: "DUE",
      title: renewalEventTitle("DUE", lead.client_name, lead.policy_product, mode),
      event_timestamp: due.toISOString(),
      is_background_reminder: false,
    },
    // A policy that renews itself needs no countdown.
    ...(mode === "auto" ? [] : offsets)
      .map((o) => ({ o, at: new Date(due.getTime() - o.offset_seconds * 1000) }))
      .filter(({ at }) => at.getTime() > now.getTime())
      .map(({ o, at }) => ({
        ...base,
        milestone: o.milestone,
        title: renewalEventTitle(o.milestone, lead.client_name, lead.policy_product),
        event_timestamp: at.toISOString(),
        is_background_reminder: true,
      })),
  ];
}
