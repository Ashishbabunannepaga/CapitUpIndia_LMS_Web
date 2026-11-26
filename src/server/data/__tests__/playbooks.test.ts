import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { leads, workTasks, workTaskTags } from "../../db/schema";
import { AccessDeniedError } from "../errors";
import { createLead } from "../leads";
import { deliverTaskDueReminders } from "../task-reminders";
import { notifications } from "../../db/schema";
import { addPlaybookStep, createPlaybook, listPlaybooks, runPlaybooks, setPlaybookActive } from "../playbooks";
import { testWorld } from "./helpers";

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
});
afterAll(async () => {
  await w.dispose();
});

const tasksFor = (leadId: number) =>
  w.ctx.db.select({ id: workTasks.id, title: workTasks.title, assignee_id: workTasks.assignee_id, due_at: workTasks.due_at }).from(workTasks).where(eq(workTasks.lead_id, leadId));

describe("renewal playbooks", () => {
  it("ship switched off with the default steps, and only admins manage them", async () => {
    const books = await listPlaybooks(w.ctx, w.admin);
    expect(books.map((b) => [b.name, b.active, b.steps.length])).toEqual([
      ["Corporate renewal", false, 5],
      ["Retail renewal", false, 3],
    ]);
    await expect(listPlaybooks(w.ctx, w.amit)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(setPlaybookActive(w.ctx, w.amit, 1, true)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("creates each step for the lead's agent when its date comes, once per renewal", async () => {
    const at = new Date("2031-01-01T05:00:00.000Z"); // 1 Jan 2031, 10:30 IST
    const id = await createLead(w.ctx, w.admin, {
      client_name: "Acme Pvt Ltd",
      renewal_date: "2031-03-01", // 59 days away: step 1 (-60) is due 31 Dec, inside the 3-day grace
      assigned_agent_id: w.amit.id,
      business_type: "Corporate",
    });
    expect(await runPlaybooks(w.ctx, at)).toBe(0); // off

    await setPlaybookActive(w.ctx, w.admin, 1, true);
    await runPlaybooks(w.ctx, at);
    let tasks = await tasksFor(id);
    expect(tasks.map((t) => t.title)).toEqual(["Collect last policy and employee list from Acme Pvt Ltd"]);
    expect(tasks[0]).toMatchObject({ assignee_id: w.amit.id, due_at: "2030-12-31T12:30:00.000Z" });
    const tags = await w.ctx.db.select({ tag: workTaskTags.tag }).from(workTaskTags).where(eq(workTaskTags.task_id, tasks[0]!.id));
    expect(tags.map((t) => t.tag).sort()).toEqual(["docs", "playbook", "renewal"]);

    // Same hour again: nothing new. 15 days later, step 2 (-45, opens 3 days early) appears.
    await runPlaybooks(w.ctx, at);
    expect(await tasksFor(id)).toHaveLength(1);
    await runPlaybooks(w.ctx, new Date("2031-01-12T05:00:00.000Z"));
    tasks = await tasksFor(id);
    expect(tasks.map((t) => t.title)).toContain("Send Acme Pvt Ltd renewal to 3 insurers for quotes");

    // A lost lead gets no more steps.
    await w.ctx.db.update(leads).set({ status: "Closed Lost" }).where(eq(leads.id, id));
    await runPlaybooks(w.ctx, new Date("2031-02-01T05:00:00.000Z"));
    expect(await tasksFor(id)).toHaveLength(2);
  });

  it("skips steps long overdue, other business types, and leads with no agent", async () => {
    const at = new Date("2031-06-01T05:00:00.000Z");
    const late = await createLead(w.ctx, w.admin, { client_name: "Late Co", renewal_date: "2031-06-05", assigned_agent_id: w.neha.id, business_type: "Corporate" });
    const retail = await createLead(w.ctx, w.admin, { client_name: "Mr Retail", renewal_date: "2031-06-05", assigned_agent_id: w.neha.id, business_type: "Retail" });
    const nobody = await createLead(w.ctx, w.admin, { client_name: "Nobody Ltd", renewal_date: "2031-06-05", business_type: "Corporate" });
    await runPlaybooks(w.ctx, at);
    // Corporate, 4 days out: -10 (due 26 May) is too late; -3 (due 2 Jun) is open.
    expect((await tasksFor(late)).map((t) => t.title)).toEqual(["Renewal not confirmed yet: Late Co"]);
    expect(await tasksFor(retail)).toHaveLength(0); // retail playbook is still off
    expect(await tasksFor(nobody)).toHaveLength(0);

    // Nobody gave a playbook task, so its escalation goes to the admins.
    const [step] = await tasksFor(late);
    await deliverTaskDueReminders(w.ctx, new Date("2031-06-03T06:30:00.000Z"));
    const told = await w.ctx.db
      .select({ title: notifications.title })
      .from(notifications)
      .where(and(eq(notifications.user_id, w.admin.id), eq(notifications.task_id, step!.id)));
    expect(told.map((t) => t.title)).toContain("Still not done: Renewal not confirmed yet: Late Co");
  });

  it("lets admins build their own playbook", async () => {
    const id = await createPlaybook(w.ctx, w.admin, "Motor renewal", "Retail");
    await addPlaybookStep(w.ctx, w.admin, id, { day_offset: -7, title: "Ask {client} for the RC copy", tags: "motor" });
    await setPlaybookActive(w.ctx, w.admin, id, true);
    const lead = await createLead(w.ctx, w.admin, { client_name: "Ravi", renewal_date: "2031-08-10", assigned_agent_id: w.amit.id, business_type: "Retail" });
    await runPlaybooks(w.ctx, new Date("2031-08-01T05:00:00.000Z"));
    const rows = await w.ctx.db.select({ title: workTasks.title }).from(workTasks).where(and(eq(workTasks.lead_id, lead)));
    expect(rows.map((r) => r.title)).toEqual(["Ask Ravi for the RC copy"]);
  });
});
