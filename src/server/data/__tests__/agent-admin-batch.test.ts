import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { parseLeadFilters } from "@/lib/lead-filters";
import { addDays, todayInBusinessTz } from "@/lib/dates";
import { businessHhmm } from "@/lib/clock";

import { events, leads, notifications } from "../../db/schema";
import { agentWorkload, renewalPipeline } from "../analytics";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { createTask, setEventDone, snoozeTask } from "../events";
import { diffLead, leadHistory, listLeadAudit } from "../history";
import {
  addLeadNote,
  assignLead,
  createLead,
  getLeadPage,
  leadsForExport,
  listLeads,
  logLeadContact,
  reassignLeads,
  setLeadStatus,
  setLeadTags,
  updateLead,
} from "../leads";
import { agentForView, myDay } from "../my-day";
import { getStaleDays, setStaleDays } from "../stale";
import { testWorld } from "./helpers";

// The agent and admin feature batch: bulk reassign, tags, stale leads, snooze,
// lead history, the audit log, workload, the renewal report and "view as agent".

let w: Awaited<ReturnType<typeof testWorld>>;
const filters = (q: Record<string, string> = {}) => parseLeadFilters(q);
const today = todayInBusinessTz();

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

async function backdate(id: number, days: number) {
  const old = new Date(Date.now() - days * 86_400_000).toISOString();
  await w.ctx.db.update(leads).set({ updated_at: old, created_at: old }).where(eq(leads.id, id));
}

describe("bulk reassign", () => {
  it("moves many leads in one go, audits each and sends one bell message", async () => {
    const a = await createLead(w.ctx, w.amit, { client_name: "Bulk One Pvt Ltd", renewal_date: addDays(today, 40) });
    const b = await createLead(w.ctx, w.amit, { client_name: "Bulk Two Pvt Ltd" });
    const c = await createLead(w.ctx, w.neha, { client_name: "Bulk Three Pvt Ltd" });
    const before = await w.ctx.db.select().from(notifications).where(eq(notifications.user_id, w.neha.id));

    expect(await reassignLeads(w.ctx, w.admin, [a, b, c, a], w.neha.id)).toBe(2);

    const page = await getLeadPage(w.ctx, w.neha, a);
    expect(page?.lead.assigned_agent_id).toBe(w.neha.id);
    // Renewal milestones follow the new owner.
    expect(page?.events.filter((e) => e.is_system_generated).every((e) => e.assigned_agent_id === w.neha.id)).toBe(true);
    expect(await getLeadPage(w.ctx, w.amit, b)).toBeNull();
    const after = await w.ctx.db.select().from(notifications).where(eq(notifications.user_id, w.neha.id));
    expect(after.length - before.length).toBe(1);
    expect(after.at(-1)?.title).toBe("2 leads reassigned to you");
    const audit = await listLeadAudit(w.ctx, w.admin, { field: "assigned_agent_id", actorId: w.admin.id });
    expect(audit.entries.filter((e) => [a, b].includes(e.lead_id))).toHaveLength(2);
    expect(audit.entries[0].changes).toEqual([
      { field: "assigned_agent_id", label: "Assigned agent", from: "Amit Agent", to: "Neha Agent" },
    ]);

    // Unassigning works too.
    expect(await reassignLeads(w.ctx, w.admin, [c], null)).toBe(1);
  });

  it("is admin-only and checks its input", async () => {
    const own = await createLead(w.ctx, w.amit, { client_name: "Agent Bulk Try" });
    await expect(reassignLeads(w.ctx, w.amit, [own], w.amit.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(reassignLeads(w.ctx, w.admin, [], w.amit.id)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(reassignLeads(w.ctx, w.admin, [own], "not-a-person")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(reassignLeads(w.ctx, w.admin, Array.from({ length: 201 }, (_, i) => i + 1), w.amit.id)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });
});

describe("tags", () => {
  it("lets the owner tag a lead, shows tags in lists and filters by them", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Tagged Hot Co" });
    await createLead(w.ctx, w.amit, { client_name: "Untagged Co" });
    expect(await setLeadTags(w.ctx, w.amit, id, ["Hot", "VIP", "Hot"])).toEqual(["Hot", "VIP"]);
    expect((await getLeadPage(w.ctx, w.amit, id))?.tags.sort()).toEqual(["Hot", "VIP"]);

    const hot = await listLeads(w.ctx, w.amit, filters({ tag: "Hot" }));
    expect(hot.leads.map((l) => l.client_name)).toEqual(["Tagged Hot Co"]);
    expect(hot.leads[0].tags.sort()).toEqual(["Hot", "VIP"]);
    // Admins filter across everyone.
    expect((await listLeads(w.ctx, w.admin, filters({ tag: "Hot" }))).leads.map((l) => l.id)).toContain(id);

    await setLeadTags(w.ctx, w.amit, id, ["Cold"]);
    expect((await listLeads(w.ctx, w.amit, filters({ tag: "Hot" }))).leads).toEqual([]);
    const history = await leadHistory(w.ctx, w.amit, id);
    expect(history?.find((h) => h.kind === "tags")?.summary).toBe("Tags: Cold");
  });

  it("rejects unknown tags and other agents' leads", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Tag Guard Co" });
    await expect(setLeadTags(w.ctx, w.amit, id, ["Urgent!!"])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(setLeadTags(w.ctx, w.neha, id, ["Hot"])).rejects.toBeInstanceOf(InvalidInputError);
    expect((await getLeadPage(w.ctx, w.amit, id))?.tags).toEqual([]);
  });
});

describe("stale leads", () => {
  it("flags open leads with no activity past the threshold, and any activity clears it", async () => {
    const quiet = await createLead(w.ctx, w.amit, { client_name: "Stale Quiet Co" });
    const noted = await createLead(w.ctx, w.amit, { client_name: "Stale Noted Co" });
    const won = await createLead(w.ctx, w.amit, { client_name: "Stale Won Co", status: "Closed Won" });
    const fresh = await createLead(w.ctx, w.amit, { client_name: "Stale Fresh Co" });
    for (const id of [quiet, noted, won]) await backdate(id, 10);
    await addLeadNote(w.ctx, w.amit, noted, "Still talking to them");

    const stale = await listLeads(w.ctx, w.amit, filters({ stale: "1" }));
    expect(stale.leads.map((l) => l.id)).toEqual([quiet]);
    expect(stale.leads[0].is_stale).toBe(true);
    const all = await listLeads(w.ctx, w.amit, filters({ q: "Stale" }));
    expect(all.leads.filter((l) => l.is_stale).map((l) => l.id)).toEqual([quiet]);
    expect(all.leads.find((l) => l.id === fresh)?.is_stale).toBe(false);
    expect((await myDay(w.ctx, w.amit)).counts.stale).toBe(1);

    // A raised threshold clears it; a contact press clears it too.
    await setStaleDays(w.ctx, w.admin, 30);
    expect(await getStaleDays(w.ctx)).toBe(30);
    expect((await listLeads(w.ctx, w.amit, filters({ stale: "1" }))).leads).toEqual([]);
    await setStaleDays(w.ctx, w.admin, 7);
    await logLeadContact(w.ctx, w.amit, quiet, "call");
    expect((await listLeads(w.ctx, w.amit, filters({ stale: "1" }))).leads).toEqual([]);
  });

  it("only admins set the threshold, within limits", async () => {
    await expect(setStaleDays(w.ctx, w.amit, 3)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(setStaleDays(w.ctx, w.admin, 0)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(setStaleDays(w.ctx, w.admin, 1.5)).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("snooze", () => {
  it("moves an overdue task to a later day at the same time without ticking it off", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const task = await createTask(w.ctx, w.amit, { title: "Chase quote", event_timestamp: yesterday });
    const moved = await snoozeTask(w.ctx, w.amit, task.id, 3);
    const [row] = await w.ctx.db.select().from(events).where(eq(events.id, task.id));
    expect(row.event_timestamp).toBe(moved);
    expect(row.is_completed).toBe(false);
    expect(todayInBusinessTz(new Date(moved))).toBe(addDays(today, 3));
    expect(businessHhmm(moved)).toBe(businessHhmm(yesterday));
  });

  it("refuses odd durations, renewal reminders, done tasks and other people's tasks", async () => {
    const task = await createTask(w.ctx, w.amit, { title: "Snooze guard", event_timestamp: new Date().toISOString() });
    await expect(snoozeTask(w.ctx, w.amit, task.id, 2)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(snoozeTask(w.ctx, w.neha, task.id, 1)).rejects.toBeInstanceOf(InvalidInputError);
    const lead = await createLead(w.ctx, w.amit, { client_name: "Snooze Renewal Co", renewal_date: addDays(today, 5) });
    const due = (await getLeadPage(w.ctx, w.amit, lead))!.events.find((e) => e.is_system_generated)!;
    await expect(snoozeTask(w.ctx, w.amit, due.id, 1)).rejects.toBeInstanceOf(AccessDeniedError);
    await setEventDone(w.ctx, w.amit, task.id, true);
    await expect(snoozeTask(w.ctx, w.amit, task.id, 1)).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("lead history", () => {
  it("lists every kind of change with who did it, newest first", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "History Co", poc_name: "Ravi" });
    await setLeadStatus(w.ctx, w.amit, id, "Quoted");
    await updateLead(w.ctx, w.amit, id, { sub_product_name: "GMC", poc_contact_number: "98450 12345" });
    await addLeadNote(w.ctx, w.amit, id, "Sent the quote");
    await logLeadContact(w.ctx, w.amit, id, "whatsapp", true);
    const task = await createTask(w.ctx, w.amit, { title: "Call back", event_timestamp: new Date().toISOString(), lead_id: id });
    await setEventDone(w.ctx, w.amit, task.id, true);
    await assignLead(w.ctx, w.admin, id, w.neha.id);

    const amitView = await leadHistory(w.ctx, w.amit, id);
    expect(amitView).toBeNull(); // no longer Amit's lead
    const items = (await leadHistory(w.ctx, w.neha, id))!;
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));
    expect(byKind.created).toMatchObject({ who: "Amit Agent", summary: "Created the lead for Amit Agent" });
    expect(byKind.status).toMatchObject({ who: "Amit Agent", summary: "Status Prospect → Quoted" });
    expect(byKind.edited.changes.map((c: { label: string }) => c.label)).toEqual(["Sub-product", "Primary POC phone"]);
    expect(byKind.note).toMatchObject({ who: "Amit Agent", summary: "Sent the quote" });
    expect(byKind.contact.summary).toBe("Sent a WhatsApp with an AI follow-up draft");
    expect(byKind.assigned).toMatchObject({ who: "Asha Admin", summary: "Assigned Amit Agent → Neha Agent" });
    // Neha sees only her own tasks on the lead, like the lead page.
    expect(byKind.task_created).toBeUndefined();
    const admin = (await leadHistory(w.ctx, w.admin, id))!;
    expect(admin.map((i) => i.kind)).toEqual(expect.arrayContaining(["task_created", "task_done"]));
    expect([...admin].sort((a, b) => b.at.localeCompare(a.at)).map((i) => i.at)).toEqual(admin.map((i) => i.at));
  });
});

describe("audit log", () => {
  it("shows field-level old and new values for admins only", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Audit Co", renewal_date: addDays(today, 20) });
    await updateLead(w.ctx, w.amit, id, { renewal_date: addDays(today, 25), poc_name: "Meera" });
    const { entries } = await listLeadAudit(w.ctx, w.admin, { leadId: id });
    expect(entries.map((e) => e.action)).toEqual(["UPDATE", "INSERT"]);
    expect(entries[0]).toMatchObject({ actor_name: "Amit Agent", lead_name: "Audit Co", lead_exists: true });
    expect(entries[0].changes).toEqual([
      { field: "renewal_date", label: "Renewal date", from: addDays(today, 20), to: addDays(today, 25) },
      { field: "poc_name", label: "Primary POC", from: "(empty)", to: "Meera" },
    ]);
    await expect(listLeadAudit(w.ctx, w.amit, {})).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(listLeadAudit(w.ctx, w.admin, { field: "password" })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("diffs ignore bookkeeping columns", () => {
    expect(diffLead({ updated_at: "a", client_name_normalized: "x", status: "Prospect" }, { updated_at: "b", client_name_normalized: "y", status: "Prospect" })).toEqual([]);
  });
});

describe("workload, renewal report and export", () => {
  it("counts each agent's open leads, overdue follow-ups and renewals this week", async () => {
    await createLead(w.ctx, w.neha, { client_name: "Workload Renewal Co", renewal_date: addDays(today, 3) });
    await createTask(w.ctx, w.neha, { title: "Overdue chase", event_timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    const rows = await agentWorkload(w.ctx, w.admin);
    const neha = rows.find((r) => r.agent_id === w.neha.id)!;
    expect(neha.open_leads).toBeGreaterThan(0);
    expect(neha.overdue_followups).toBeGreaterThanOrEqual(1);
    expect(neha.renewals_week).toBeGreaterThanOrEqual(1);
    expect(rows.find((r) => r.agent_id === w.amit.id)).toBeDefined();
    await expect(agentWorkload(w.ctx, w.amit)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("lists renewals in the next 90 days with their window", async () => {
    await createLead(w.ctx, w.amit, { client_name: "Window 45 Co", renewal_date: addDays(today, 45), policy_product: "Motor" });
    await createLead(w.ctx, w.amit, { client_name: "Window 100 Co", renewal_date: addDays(today, 100) });
    await createLead(w.ctx, w.amit, { client_name: "Window Lost Co", renewal_date: addDays(today, 10), status: "Closed Lost" });
    const { rows } = await renewalPipeline(w.ctx, w.admin);
    const names = rows.map((r) => r.client_name);
    expect(rows.find((r) => r.client_name === "Window 45 Co")).toMatchObject({ window: "31-60", days_left: 45, agent_name: "Amit Agent" });
    expect(names).not.toContain("Window 100 Co");
    expect(names).not.toContain("Window Lost Co");
    await expect(renewalPipeline(w.ctx, w.amit)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("exports chosen leads for admins only", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Export Co" });
    await setLeadTags(w.ctx, w.amit, id, ["Referral"]);
    const rows = await leadsForExport(w.ctx, w.admin, [id]);
    expect(rows[0]).toMatchObject({ client_name: "Export Co", agent_name: "Amit Agent", tags: ["Referral"] });
    await expect(leadsForExport(w.ctx, w.amit, [id])).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe("view as agent", () => {
  it("gives admins an agent's own My Day, read-only, and nobody else", async () => {
    const id = await createLead(w.ctx, w.neha, { client_name: "View As Co", renewal_date: addDays(today, 2) });
    const neha = await agentForView(w.ctx, w.admin, w.neha.id);
    const day = await myDay(w.ctx, neha);
    expect(day.renewals.map((l) => l.id)).toContain(id);
    expect(day.renewals.every((l) => l.assigned_agent_id === w.neha.id)).toBe(true);
    expect(day.unassigned).toBeNull();
    await expect(agentForView(w.ctx, w.amit, w.neha.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(agentForView(w.ctx, w.admin, w.admin.id)).rejects.toBeInstanceOf(InvalidInputError);
  });
});
