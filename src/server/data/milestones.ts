import "server-only";

import { businessDateTimeToIso } from "@/lib/dates";

// Renewal countdown events for a lead, as the renewal-milestones migration
// generated them: one "DUE" event at the due time on the renewal date, and a
// background reminder at each offset before it that is still in the future.

export type MilestoneOffset = { milestone: string; offset_seconds: number };

type LeadForMilestones = {
  client_name: string;
  policy_product: string;
  renewal_date: string | null;
  assigned_agent_id: string | null;
};

export function renewalEventTitle(milestone: string, clientName: string, product: string): string {
  const title =
    milestone === "DUE"
      ? `Renewal due: ${clientName} (${product})`
      : `${milestone} renewal reminder: ${clientName} (${product})`;
  return title.slice(0, 300);
}

/** The events a lead's renewal date implies right now (none without a date). */
export function milestoneEvents(
  lead: LeadForMilestones,
  offsets: MilestoneOffset[],
  dueTime: string,
  now: Date = new Date(),
) {
  if (!lead.renewal_date) return [];
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
      title: renewalEventTitle("DUE", lead.client_name, lead.policy_product),
      event_timestamp: due.toISOString(),
      is_background_reminder: false,
    },
    ...offsets
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
