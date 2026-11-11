import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readSheet } from "read-excel-file/node";

vi.mock("server-only", () => ({}));

import { monthlyReportSheets, monthlyReportXlsx } from "@/lib/reports/monthly-report";

import { listActivity, listLeadTracker, monthlyReport, monthRange, summariseByAgent } from "../activity";
import { attachCardToLead } from "../cards";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { createTask, setEventDone } from "../events";
import { addLeadNote, assignLead, createLead, deleteLead, logLeadContact, setLeadStatus, updateLead } from "../leads";
import { testWorld } from "./helpers";

// The admins' activity log, live leads tracker and monthly report.

let w: Awaited<ReturnType<typeof testWorld>>;
let acme: number;
let beta: number;
let start: string;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

beforeAll(async () => {
  w = await testWorld();
  start = new Date(Date.now() - 1000).toISOString();
  acme = await createLead(w.ctx, w.amit, { client_name: "Acme Activity Pvt Ltd", poc_name: "Ravi", poc_designation: "Director" });
  beta = await createLead(w.ctx, w.neha, { client_name: "Beta Activity" });
  await setLeadStatus(w.ctx, w.amit, acme, "Quoted");
  await setLeadStatus(w.ctx, w.amit, acme, "Closed Won");
  await addLeadNote(w.ctx, w.amit, acme, "Called Ravi, quote accepted");
  await logLeadContact(w.ctx, w.amit, acme, "whatsapp", true);
  await updateLead(w.ctx, w.amit, acme, { sub_product_name: "GMC" });
  const task = await createTask(w.ctx, w.amit, { title: "Send policy copy", event_timestamp: new Date().toISOString(), lead_id: acme });
  await setEventDone(w.ctx, w.amit, task.id, true);
  await createTask(w.ctx, w.amit, { title: "Collect KYC", event_timestamp: new Date().toISOString(), lead_id: acme });
  await attachCardToLead(w.ctx, w.neha, beta, PNG);
  await assignLead(w.ctx, w.admin, beta, w.amit.id);
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

describe("activity log", () => {
  it("lists every kind of action with who did it and on which lead", async () => {
    const items = await listActivity(w.ctx, w.admin, { from: start });
    const kinds = items.map((i) => `${i.agent_name}:${i.kind}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "Amit Agent:lead_created",
        "Neha Agent:lead_created",
        "Amit Agent:status_changed",
        "Amit Agent:note_added",
        "Amit Agent:contact",
        "Amit Agent:lead_edited",
        "Amit Agent:task_created",
        "Amit Agent:task_completed",
        "Neha Agent:card_uploaded",
        "Asha Admin:lead_assigned",
      ]),
    );
    const won = items.find((i) => i.kind === "status_changed" && i.detail.endsWith("Closed Won"));
    expect(won).toMatchObject({ lead_id: acme, lead_name: "Acme Activity Pvt Ltd", detail: "Quoted → Closed Won", lead_exists: true });
    expect(items.find((i) => i.kind === "lead_assigned")?.detail).toBe("Neha Agent → Amit Agent");
    expect(items.find((i) => i.kind === "contact")?.detail).toBe("WhatsApp with AI follow-up draft");
    expect(items.find((i) => i.kind === "task_completed")).toMatchObject({ lead_id: acme, detail: "Send policy copy" });
    // Newest first.
    expect([...items].sort((a, b) => b.at.localeCompare(a.at)).map((i) => i.at)).toEqual(items.map((i) => i.at));
  });

  it("filters by agent, action and time", async () => {
    const neha = await listActivity(w.ctx, w.admin, { from: start, agentId: w.neha.id });
    expect(new Set(neha.map((i) => i.kind))).toEqual(new Set(["lead_created", "card_uploaded"]));
    const statuses = await listActivity(w.ctx, w.admin, { from: start, kind: "status_changed" });
    expect(statuses).toHaveLength(2);
    expect(await listActivity(w.ctx, w.admin, { from: new Date(Date.now() + 60_000).toISOString() })).toEqual([]);
    expect(await listActivity(w.ctx, w.admin, { from: start, limit: 3 })).toHaveLength(3);
    await expect(listActivity(w.ctx, w.admin, { kind: "hack" as never })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("keeps deleted leads in the log by name", async () => {
    const gone = await createLead(w.ctx, w.admin, { client_name: "Gone Soon Ltd" });
    await deleteLead(w.ctx, w.admin, gone);
    const items = await listActivity(w.ctx, w.admin, { leadId: gone });
    expect(items.map((i) => i.kind).sort()).toEqual(["lead_created", "lead_deleted"]);
    expect(items.every((i) => i.lead_name === "Gone Soon Ltd" && !i.lead_exists)).toBe(true);
  });

  it("does not log a task ticked off twice", async () => {
    const task = await createTask(w.ctx, w.neha, { title: "Twice", event_timestamp: new Date().toISOString() });
    await setEventDone(w.ctx, w.neha, task.id, true);
    await setEventDone(w.ctx, w.neha, task.id, true);
    const done = await listActivity(w.ctx, w.admin, { agentId: w.neha.id, kind: "task_completed" });
    expect(done.filter((i) => i.detail === "Twice")).toHaveLength(1);
  });

  it("summarises each person's actions", async () => {
    const summary = summariseByAgent(await listActivity(w.ctx, w.admin, { from: start }));
    const amit = summary.find((s) => s.agent_name === "Amit Agent");
    expect(amit).toMatchObject({ status_changes: 2, notes: 1, contacts: 1, tasks_completed: 1, leads_created: 1 });
    expect(summary[0].agent_name).toBe("Amit Agent");
  });

  it("is for admins only", async () => {
    await expect(listActivity(w.ctx, w.amit)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(listLeadTracker(w.ctx, w.neha)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(monthlyReport(w.ctx, w.amit, "2026-11")).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe("live leads tracker", () => {
  it("lists leads by latest activity with owner, last change and counts", async () => {
    const rows = await listLeadTracker(w.ctx, w.admin);
    const row = rows.find((r) => r.id === acme);
    expect(row).toMatchObject({
      client_name: "Acme Activity Pvt Ltd",
      status: "Closed Won",
      agent_name: "Amit Agent",
      last_changed_by: "Amit Agent",
      notes: 1,
      open_tasks: 1,
    });
    expect(rows.find((r) => r.id === beta)).toMatchObject({ agent_name: "Amit Agent", last_changed_by: "Asha Admin" });
    const order = rows.map((r) => r.last_activity_at);
    expect([...order].sort().reverse()).toEqual(order);
  });

  it("filters by owner, status and name", async () => {
    expect((await listLeadTracker(w.ctx, w.admin, { status: "Closed Won" })).map((r) => r.id)).toEqual([acme]);
    expect((await listLeadTracker(w.ctx, w.admin, { q: "beta act" })).map((r) => r.id)).toEqual([beta]);
    expect((await listLeadTracker(w.ctx, w.admin, { agentId: w.neha.id })).map((r) => r.id)).toEqual([]);
    await expect(listLeadTracker(w.ctx, w.admin, { status: "Bogus" })).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("monthly report", () => {
  it("covers IST calendar months", () => {
    expect(monthRange("2026-11")).toEqual({ from: "2026-10-31T18:30:00.000Z", to: "2026-11-30T18:30:00.000Z" });
    expect(monthRange("2026-12").to).toBe("2026-12-31T18:30:00.000Z");
    expect(() => monthRange("2026-13")).toThrow(InvalidInputError);
    expect(() => monthRange("26-1")).toThrow(InvalidInputError);
  });

  it("builds a workbook with agent summary, every lead and the month's activity", async () => {
    const now = new Date();
    const month = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 7);
    const report = await monthlyReport(w.ctx, w.admin, month, now);
    const sheets = monthlyReportSheets(report);
    expect(sheets.map((s) => s.name)).toEqual(["Agent summary", "Leads", "Activity log", "About"]);

    const [summary, leadSheet, activity] = sheets;
    const header = summary.rows[0] as string[];
    const amit = summary.rows.find((r) => r[0] === "Amit Agent")!;
    const col = (name: string) => header.indexOf(name);
    expect(amit[col("Leads owned (now)")]).toBe(2);
    expect(amit[col("Closed Won")]).toBe(1);
    expect(amit[col("Win rate % (won ÷ closed)")]).toBe(100);
    expect(amit[col("Conversion rate % (won ÷ owned)")]).toBe(50);
    expect(amit[col("Status updates (month)")]).toBe(2);
    expect(amit[col("WhatsApp (month)")]).toBe(1);

    const leadHeader = leadSheet.rows[0] as string[];
    const acmeRow = leadSheet.rows.find((r) => r[0] === acme)!;
    const cell = (name: string) => acmeRow[leadHeader.indexOf(name)];
    expect(cell("Agent assigned")).toBe("Amit Agent");
    expect(cell("POC 1")).toBe("Ravi (Director)");
    expect(cell("Status updates (month)")).toBe(2);
    expect(cell("Status updates by agent (month)")).toBe("Amit Agent 2");
    expect(cell("Tasks linked")).toBe(2);
    expect(cell("Tasks done")).toBe(1);
    expect(String(cell("Notes (all, timestamped)"))).toMatch(/^\[Amit Agent - \d{4}-\d\d-\d\d \d\d:\d\d\]: Called Ravi, quote accepted$/);
    expect(String(cell("Activity this month (timestamped)"))).toContain("Amit Agent - Changed status: Quoted → Closed Won");
    expect(activity.rows.length).toBe(report.activity.length + 1);

    // A real .xlsx that spreadsheet apps can open.
    const bytes = monthlyReportXlsx(report);
    const matrix = await readSheet(Buffer.from(bytes));
    expect(matrix[0][0]).toBe("Agent");
    expect(matrix.find((r) => r[0] === "Amit Agent")?.[3]).toBe(2);
  });

  it("an empty month still has every lead", async () => {
    const report = await monthlyReport(w.ctx, w.admin, "2020-01");
    expect(report.activity).toEqual([]);
    expect(report.leads.length).toBeGreaterThanOrEqual(2);
  });
});
