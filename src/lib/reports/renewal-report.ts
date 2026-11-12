import { buildXlsx, type Cell, type Sheet } from "@/lib/xlsx";
import type { RenewalReportRow, RenewalWindow } from "@/server/data/analytics";
import type { LeadWithAgent } from "@/server/data/leads";

import { istStamp } from "./monthly-report";

// Workbooks for two downloads: the renewal pipeline (Analytics) and the
// leads an admin ticked in the leads table (Export selected).

const WINDOWS: { key: RenewalWindow; title: string }[] = [
  { key: "0-30", title: "Next 30 days" },
  { key: "31-60", title: "31-60 days" },
  { key: "61-90", title: "61-90 days" },
];

/** Summary (agent × product × window) plus one sheet of leads per 30-day window. */
export function renewalReportSheets(today: string, rows: RenewalReportRow[]): Sheet[] {
  const groups = new Map<string, { agent: string; product: string; counts: Record<RenewalWindow, number> }>();
  for (const row of rows) {
    const key = `${row.agent_name}\u0000${row.policy_product}`;
    const group = groups.get(key) ?? { agent: row.agent_name, product: row.policy_product, counts: { "0-30": 0, "31-60": 0, "61-90": 0 } };
    group.counts[row.window]++;
    groups.set(key, group);
  }
  const summary: Cell[][] = [["Agent", "Product", "Next 30 days", "31-60 days", "61-90 days", "Total"]];
  let agent = "";
  const agentTotals = new Map<string, Record<RenewalWindow, number>>();
  for (const g of groups.values()) {
    const t = agentTotals.get(g.agent) ?? { "0-30": 0, "31-60": 0, "61-90": 0 };
    for (const w of WINDOWS) t[w.key] += g.counts[w.key];
    agentTotals.set(g.agent, t);
  }
  for (const g of groups.values()) {
    if (agent && g.agent !== agent) pushTotal(summary, agent, agentTotals.get(agent)!);
    agent = g.agent;
    const c = g.counts;
    summary.push([g.agent, g.product, c["0-30"], c["31-60"], c["61-90"], c["0-30"] + c["31-60"] + c["61-90"]]);
  }
  if (agent) pushTotal(summary, agent, agentTotals.get(agent)!);
  const all = { "0-30": 0, "31-60": 0, "61-90": 0 };
  for (const row of rows) all[row.window]++;
  summary.push(["All agents", "", all["0-30"], all["31-60"], all["61-90"], rows.length]);
  summary.push([]);
  summary.push([`Leads (not Closed Lost) renewing from ${today}, as of ${istStamp(new Date().toISOString())} IST.`]);

  const header = ["Agent", "Product", "Sub-product", "Company", "Renewal date", "Days left", "Status", "Type", "Corporate / retail", "POC", "Phone", "Email", "Lead #"];
  const windowSheets = WINDOWS.map(({ key, title }) => ({
    name: title,
    rows: [
      header,
      ...rows
        .filter((r) => r.window === key)
        .map((r) => [
          r.agent_name,
          r.policy_product,
          r.sub_product_name,
          r.client_name,
          r.renewal_date,
          r.days_left,
          r.status,
          r.type,
          r.business_type,
          r.poc_name,
          r.poc_contact_number,
          r.poc_email_id,
          r.id,
        ]),
    ],
  }));
  return [{ name: "Summary", rows: summary, widths: [24, 18, 14, 12, 12, 10] }, ...windowSheets];
}

function pushTotal(summary: Cell[][], agent: string, t: Record<RenewalWindow, number>) {
  summary.push([`${agent} total`, "", t["0-30"], t["31-60"], t["61-90"], t["0-30"] + t["31-60"] + t["61-90"]]);
}

export function renewalReportXlsx(today: string, rows: RenewalReportRow[]): Uint8Array {
  return buildXlsx(renewalReportSheets(today, rows));
}

/** The leads an admin selected in the leads table, one row each. */
export function selectedLeadsXlsx(leads: (LeadWithAgent & { tags: string[] })[]): Uint8Array {
  const rows: Cell[][] = [
    [
      "Lead #", "Company", "Status", "Type", "Corporate / retail", "Product", "Sub-product", "Renewal date", "Agent", "Tags",
      "POC", "POC designation", "POC phone", "POC email", "POC 2", "POC 2 phone", "POC 2 email", "RM", "Address", "Notes",
      "Duplicate", "Created (IST)", "Updated (IST)",
    ],
    ...leads.map((l) => [
      l.id, l.client_name, l.status, l.type, l.business_type, l.policy_product, l.sub_product_name, l.renewal_date ?? "",
      l.agent_name ?? "Unassigned", l.tags.join(", "), l.poc_name, l.poc_designation, l.poc_contact_number, l.poc_email_id,
      l.poc2_name, l.poc2_contact_number, l.poc2_email_id, l.relationship_manager, l.address, l.notes,
      l.is_duplicate ? "Yes" : "", istStamp(l.created_at), istStamp(l.updated_at),
    ]),
  ];
  return buildXlsx([{ name: "Leads", rows }]);
}
