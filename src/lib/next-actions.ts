import { daysBetween } from "@/lib/dates";
import { mailtoHref, telHref, whatsappHref } from "@/lib/contact-links";

// "Do this next" on My Day: the few things most worth doing now, ranked by
// rules (no AI, so it is instant and free), each with one-click actions.

export type NextAction = {
  key: string;
  score: number;
  title: string;
  why: string;
  href: string;
  links: { label: "WhatsApp" | "Call" | "Email" | "Open"; href: string }[];
};

type LeadLike = {
  id: number;
  client_name: string;
  renewal_date: string | null;
  policy_product: string;
  poc_name: string;
  poc_contact_number: string;
  poc_email_id: string;
};

type TaskLike = {
  id: number;
  title: string;
  priority: "P1" | "P2" | "P3";
  due_at: string | null;
  approval: "pending" | "approved" | "rejected" | null;
  lead_name: string | null;
};

const PRIORITY_WEIGHT = { P1: 30, P2: 15, P3: 0 } as const;

function contactLinks(lead: LeadLike, message: string, subject: string): NextAction["links"] {
  const links: NextAction["links"] = [];
  const wa = whatsappHref(lead.poc_contact_number, message);
  if (wa) links.push({ label: "WhatsApp", href: wa });
  const tel = telHref(lead.poc_contact_number);
  if (tel) links.push({ label: "Call", href: tel });
  const mail = mailtoHref(lead.poc_email_id, subject, message);
  if (mail) links.push({ label: "Email", href: mail });
  return links;
}

const product = (lead: LeadLike) => (lead.policy_product === "Not Specified" ? "insurance" : lead.policy_product.toLowerCase());
const hello = (lead: LeadLike) => `Hello${lead.poc_name ? ` ${lead.poc_name.split(" ")[0]}` : ""}`;

export function rankNextActions(input: {
  today: string;
  now: Date;
  agentName: string;
  tasks: readonly TaskLike[];
  /** Renewals in the next 30 days (only the next 7 are used). */
  renewals: readonly LeadLike[];
  overdueRenewals: readonly LeadLike[];
  awaitingPolicy: readonly LeadLike[];
  limit?: number;
}): NextAction[] {
  const { today, now } = input;
  const items: NextAction[] = [];

  for (const t of input.tasks) {
    const late = t.due_at ? now.getTime() - Date.parse(t.due_at) : null;
    const overdue = late !== null && late > 0;
    const dueToday = t.due_at !== null && !overdue && t.due_at.slice(0, 10) <= today;
    if (t.approval === "pending") {
      items.push({
        key: `a${t.id}`,
        score: 95,
        title: t.title,
        why: "Someone is waiting on your approval.",
        href: `/tasks/${t.id}`,
        links: [{ label: "Open", href: `/tasks/${t.id}` }],
      });
      continue;
    }
    if (!overdue && !dueToday && t.priority !== "P1") continue;
    items.push({
      key: `t${t.id}`,
      score: (overdue ? 70 : dueToday ? 50 : 40) + PRIORITY_WEIGHT[t.priority] + (overdue ? Math.min(10, Math.floor(late! / 3_600_000)) : 0),
      title: t.title,
      why: `${t.priority} task${overdue ? ", overdue" : dueToday ? ", due today" : ""}${t.lead_name ? ` · ${t.lead_name}` : ""}.`,
      href: `/tasks/${t.id}`,
      links: [{ label: "Open", href: `/tasks/${t.id}` }],
    });
  }

  for (const lead of input.overdueRenewals) {
    const days = lead.renewal_date ? -daysBetween(today, lead.renewal_date) : 0;
    const message = `${hello(lead)}, this is ${input.agentName} from CapitUp India. Your ${product(lead)} policy renewal was due on ${lead.renewal_date}. Can we close it this week? I can share the options today.`;
    items.push({
      key: `o${lead.id}`,
      score: 85 - Math.min(25, days),
      title: `Chase the overdue renewal: ${lead.client_name}`,
      why: `Renewal was due ${days} day${days === 1 ? "" : "s"} ago.`,
      href: `/leads/${lead.id}`,
      links: [...contactLinks(lead, message, `${lead.client_name}: your policy renewal`), { label: "Open", href: `/leads/${lead.id}` }],
    });
  }

  for (const lead of input.renewals) {
    if (!lead.renewal_date) continue;
    const days = daysBetween(today, lead.renewal_date);
    if (days > 7) continue;
    const message = `${hello(lead)}, this is ${input.agentName} from CapitUp India. Your ${product(lead)} policy renews on ${lead.renewal_date}. Shall I share the renewal options?`;
    items.push({
      key: `r${lead.id}`,
      score: 80 - days * 4,
      title: `Renewal ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}: ${lead.client_name}`,
      why: `${lead.policy_product} renewal on ${lead.renewal_date}.`,
      href: `/leads/${lead.id}`,
      links: [...contactLinks(lead, message, `${lead.client_name}: renewal on ${lead.renewal_date}`), { label: "Open", href: `/leads/${lead.id}` }],
    });
  }

  for (const lead of input.awaitingPolicy.slice(0, 3)) {
    const message = `${hello(lead)}, this is ${input.agentName} from CapitUp India. Could you share the issued policy copy for our records?`;
    items.push({
      key: `p${lead.id}`,
      score: 45,
      title: `Get the policy copy: ${lead.client_name}`,
      why: "Closed, but the policy isn't uploaded yet.",
      href: `/leads/${lead.id}`,
      links: [...contactLinks(lead, message, `${lead.client_name}: policy copy`), { label: "Open", href: `/leads/${lead.id}` }],
    });
  }

  return items.sort((a, b) => b.score - a.score).slice(0, input.limit ?? 5);
}
