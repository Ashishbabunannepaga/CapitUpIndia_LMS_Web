import { ACTIVITY_KIND_LABELS, LEAD_STATUSES } from "@/lib/domain";
import { buildXlsx, type Cell, type Sheet } from "@/lib/xlsx";
import type { ActivityItem, MonthlyReport, ReportLead } from "@/server/data/activity";

// Turns the monthly report data (src/server/data/activity.ts) into the
// workbook admins download: agent summary, every lead, the month's activity.

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** "2026-11-05 14:30" in IST: reads well and sorts correctly in Excel. */
export function istStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}

function percent(part: number, whole: number): Cell {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : "";
}

function poc(name: string, designation: string, phone: string, email: string): string {
  // A designation alone (the default "poc" on an empty slot) is not a contact.
  const head = name.trim() ? [name, designation && designation !== name ? `(${designation})` : ""].filter(Boolean).join(" ") : "";
  return [head, phone, email].filter((v) => v && v.trim()).join(" · ");
}

function countBy(items: ActivityItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.agent_name, (counts.get(item.agent_name) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => `${name} ${n}`).join(", ");
}

function group<T>(items: T[], key: (item: T) => number | null): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

function activityLine(item: ActivityItem): string {
  const detail = item.detail ? `: ${item.detail.replace(/\s+/g, " ")}` : "";
  return `[${istStamp(item.at)}] ${item.agent_name} - ${ACTIVITY_KIND_LABELS[item.kind]}${detail}`;
}

type AgentRow = {
  name: string;
  role: string;
  active: string;
  leads: ReportLead[];
  activity: ActivityItem[];
};

function agentSummaryRow(row: AgentRow): Cell[] {
  const status = (s: string) => row.leads.filter((l) => l.status === s).length;
  const won = status("Closed Won");
  const lost = status("Closed Lost");
  const kind = (k: ActivityItem["kind"]) => row.activity.filter((a) => a.kind === k).length;
  const channel = (c: string) => row.activity.filter((a) => a.kind === "contact" && a.detail.startsWith(c)).length;
  const times = row.activity.map((a) => a.at).sort();
  return [
    row.name,
    row.role,
    row.active,
    row.leads.length,
    ...LEAD_STATUSES.map((s) => status(s)),
    percent(won, won + lost),
    percent(won, row.leads.length),
    kind("lead_created"),
    kind("status_changed"),
    kind("note_added"),
    kind("task_created"),
    kind("task_completed"),
    channel("Call"),
    channel("WhatsApp"),
    channel("Email"),
    kind("card_uploaded"),
    row.activity.length,
    istStamp(times[0]),
    istStamp(times.at(-1)),
  ];
}

export function monthlyReportSheets(report: MonthlyReport): Sheet[] {
  const notesByLead = group(report.notes, (n) => n.lead_id);
  const tasksByLead = group(report.tasks, (t) => t.lead_id);
  const activityByLead = group(report.activity, (a) => a.lead_id);

  // --- Agent summary
  const agentRows: AgentRow[] = report.team.map((member) => ({
    name: member.full_name,
    role: member.role === "ADMIN" ? "Admin" : "Agent",
    active: member.is_active ? "Yes" : "No",
    leads: report.leads.filter((l) => l.assigned_agent_id === member.id),
    activity: report.activity.filter((a) => a.agent_id === member.id),
  }));
  const known = new Set(report.team.map((t) => t.id));
  const unassigned: AgentRow = {
    name: "Unassigned / system",
    role: "",
    active: "",
    leads: report.leads.filter((l) => !l.assigned_agent_id || !known.has(l.assigned_agent_id)),
    activity: report.activity.filter((a) => !a.agent_id || !known.has(a.agent_id)),
  };
  const total: AgentRow = { name: "All", role: "", active: "", leads: report.leads, activity: report.activity };
  const summary: Sheet = {
    name: "Agent summary",
    rows: [
      [
        "Agent",
        "Role",
        "Active",
        "Leads owned (now)",
        ...LEAD_STATUSES.map((s) => (s === "Active Client" ? "Active clients" : s)),
        "Win rate % (won ÷ closed)",
        "Conversion rate % (won ÷ owned)",
        "Leads created (month)",
        "Status updates (month)",
        "Notes added (month)",
        "Tasks created (month)",
        "Tasks completed (month)",
        "Calls (month)",
        "WhatsApp (month)",
        "Emails (month)",
        "Visiting cards (month)",
        "Total actions (month)",
        "First action (month)",
        "Last action (month)",
      ],
      ...agentRows.map(agentSummaryRow),
      ...(unassigned.leads.length || unassigned.activity.length ? [agentSummaryRow(unassigned)] : []),
      agentSummaryRow(total),
    ],
  };

  // --- Leads
  const leadSheet: Sheet = {
    name: "Leads",
    rows: [
      [
        "Lead ID",
        "Company / client",
        "Agent assigned",
        "Lead type",
        "Corporate / Retail",
        "Product",
        "Sub-product",
        "Status",
        "Renewal date",
        "POC 1",
        "POC 2",
        "RM (insurer)",
        "Created on",
        "Created by",
        "Last updated",
        "Status updates (month)",
        "Status updates by agent (month)",
        "Notes added (month)",
        "Notes by agent (month)",
        "Calls / WhatsApp / Email (month)",
        "All actions (month)",
        "Tasks linked",
        "Tasks done",
        "Tasks open",
        "Tasks",
        "Notes (all, timestamped)",
        "Lead notes field",
        "Activity this month (timestamped)",
      ],
      ...report.leads.map((lead): Cell[] => {
        const activity = activityByLead.get(lead.id) ?? [];
        const statusChanges = activity.filter((a) => a.kind === "status_changed");
        const notesThisMonth = activity.filter((a) => a.kind === "note_added");
        const tasks = tasksByLead.get(lead.id) ?? [];
        const done = tasks.filter((t) => t.is_completed).length;
        return [
          lead.id,
          lead.client_name,
          lead.agent_name,
          lead.type,
          lead.business_type,
          lead.policy_product,
          lead.sub_product_name,
          lead.status,
          lead.renewal_date ?? "",
          poc(lead.poc_name, lead.poc_designation, lead.poc_contact_number, lead.poc_email_id),
          poc(lead.poc2_name, lead.poc2_designation, lead.poc2_contact_number, lead.poc2_email_id),
          lead.relationship_manager,
          istStamp(lead.created_at),
          lead.created_by_name,
          istStamp(lead.updated_at),
          statusChanges.length,
          countBy(statusChanges),
          notesThisMonth.length,
          countBy(notesThisMonth),
          activity.filter((a) => a.kind === "contact").length,
          activity.length,
          tasks.length,
          done,
          tasks.length - done,
          tasks
            .map(
              (t) =>
                `${t.title} (due ${istStamp(t.event_timestamp)}${t.owner_name ? `, ${t.owner_name}` : ""}) - ${
                  t.is_completed ? `done ${istStamp(t.completed_at)}` : "open"
                }`,
            )
            .join("\n"),
          (notesByLead.get(lead.id) ?? []).map((n) => `[${n.agent_name} - ${istStamp(n.created_at)}]: ${n.content}`).join("\n"),
          lead.notes,
          activity.map(activityLine).join("\n"),
        ];
      }),
    ],
    widths: [8, 32, 18, 10, 12, 14, 16, 13, 12, 36, 30, 22, 16, 16, 16, 10, 22, 10, 22, 12, 10, 8, 8, 8, 50, 60, 40, 70],
  };

  // --- Activity log
  const activitySheet: Sheet = {
    name: "Activity log",
    rows: [
      ["Date & time (IST)", "Agent", "Action", "Lead ID", "Lead", "Details"],
      ...report.activity.map((a): Cell[] => [
        istStamp(a.at),
        a.agent_name,
        ACTIVITY_KIND_LABELS[a.kind],
        a.lead_id ?? "",
        a.lead_exists ? a.lead_name : a.lead_name ? `${a.lead_name} (deleted)` : "",
        a.detail,
      ]),
    ],
    widths: [17, 20, 22, 8, 34, 70],
  };

  const about: Sheet = {
    name: "About",
    rows: [
      ["Monthly report", report.month],
      ["Period (IST)", `${istStamp(report.from)} to ${istStamp(report.to)}`],
      ["Generated (IST)", istStamp(report.generated_at)],
      ["Leads", report.leads.length],
      ["Actions in the month", report.activity.length],
      ["", ""],
      ["How to read it", ""],
      ["Agent summary", "Leads owned and statuses are as of the download. Everything marked (month) counts that person's own actions in the month."],
      ["Leads", "Every lead in the LMS. Notes and tasks cover the lead's whole history; the (month) columns and the activity column cover only this month."],
      ["Activity log", "Every action in the month, oldest first: leads created, status changes, reassignments, edits, visiting cards, notes, tasks, calls, WhatsApp and emails."],
      ["Win rate", "Closed Won ÷ (Closed Won + Closed Lost)."],
      ["Conversion rate", "Closed Won ÷ all leads the agent owns."],
    ],
    widths: [22, 110],
  };

  return [summary, leadSheet, activitySheet, about];
}

export function monthlyReportXlsx(report: MonthlyReport): Uint8Array {
  return buildXlsx(monthlyReportSheets(report));
}
