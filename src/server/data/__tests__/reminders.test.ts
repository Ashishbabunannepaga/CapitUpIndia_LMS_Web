import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createTask, snoozeTask, updateTask } from "../events";
import { addLeadNote, createLead } from "../leads";
import { deliverDueReminders, deliverTaskReminders, recentNotifications } from "../notifications";
import { testWorld } from "./helpers";

// R5 and R6 (enterprise audit): tasks and meetings remind their owner, and an
// ignored T-10 / T-3 renewal reminder is escalated to the admins.

let w: Awaited<ReturnType<typeof testWorld>>;
const sqlRows = async <T>(query: string, ...binds: unknown[]) => (await w.d1.prepare(query).bind(...binds).all<T>()).results;

beforeAll(async () => {
  w = await testWorld();
}, 60_000);
afterAll(async () => {
  await w?.dispose();
});

const at = (iso: string) => new Date(iso);
const bellFor = async (user: Parameters<typeof recentNotifications>[1]) => (await recentNotifications(w.ctx, user, 50)).items;

describe("task and meeting reminders", () => {
  it("reminds a meeting 15 minutes before and a task when due, once each", async () => {
    const lead = await createLead(w.ctx, w.amit, { client_name: "Reminder Pumps Ltd" });
    const meeting = await createTask(w.ctx, w.amit, { title: "Renewal pitch", kind: "meeting", lead_id: lead, event_timestamp: "2031-03-10T09:30:00.000Z" });
    const task = await createTask(w.ctx, w.amit, { title: "Call back Ravi", event_timestamp: "2031-03-10T10:00:00.000Z" });

    // 20 minutes before the meeting: nothing yet.
    expect(await deliverTaskReminders(w.ctx, at("2031-03-10T09:10:00.000Z"))).toBe(0);
    // 15 minutes before: the meeting.
    expect(await deliverTaskReminders(w.ctx, at("2031-03-10T09:15:00.000Z"))).toBe(1);
    let bell = await bellFor(w.amit);
    const meetingNote = bell.find((n) => n.title.includes("Renewal pitch"))!;
    expect(meetingNote.title).toBe("Meeting at 3:00 PM: Renewal pitch");
    expect(meetingNote.body).toContain("Lead: Reminder Pumps Ltd");
    expect(meetingNote.lead_id).toBe(lead);

    // The task at its due time; the meeting is not sent again.
    expect(await deliverTaskReminders(w.ctx, at("2031-03-10T10:00:30.000Z"))).toBe(1);
    expect(await deliverTaskReminders(w.ctx, at("2031-03-10T10:01:00.000Z"))).toBe(0);
    bell = await bellFor(w.amit);
    expect(bell.filter((n) => n.title.includes("Call back Ravi"))).toHaveLength(1);
    expect(bell.find((n) => n.title.includes("Call back Ravi"))!.title).toBe("Task due 3:30 PM: Call back Ravi");

    const sent = await sqlRows<{ id: number }>("select id from events where id in (?, ?) and reminder_sent_at is not null", meeting.id, task.id);
    expect(sent).toHaveLength(2);
  });

  it("reminds again after the task moves to a new time", async () => {
    const task = await createTask(w.ctx, w.amit, { title: "Send quote to Acme", event_timestamp: "2031-04-01T06:00:00.000Z" });
    expect(await deliverTaskReminders(w.ctx, at("2031-04-01T06:00:00.000Z"))).toBe(1);
    await updateTask(w.ctx, w.amit, task.id, { title: "Send quote to Acme", event_timestamp: "2031-04-02T06:00:00.000Z" });
    expect(await deliverTaskReminders(w.ctx, at("2031-04-02T06:00:10.000Z"))).toBe(1);
    expect((await bellFor(w.amit)).filter((n) => n.title.includes("Send quote to Acme"))).toHaveLength(2);
  });

  it("snoozing clears the reminder so the new day reminds", async () => {
    const task = await createTask(w.ctx, w.neha, { title: "Snoozed follow-up", event_timestamp: new Date(Date.now() - 60_000).toISOString() });
    expect(await deliverTaskReminders(w.ctx, new Date())).toBeGreaterThanOrEqual(1);
    await snoozeTask(w.ctx, w.neha, task.id, 1);
    const [row] = await sqlRows<{ reminder_sent_at: string | null }>("select reminder_sent_at from events where id = ?", task.id);
    expect(row.reminder_sent_at).toBeNull();
  });

  it("skips completed tasks, renewal milestones and tasks long overdue", async () => {
    const done = await createTask(w.ctx, w.amit, { title: "Already done", event_timestamp: "2031-05-01T06:00:00.000Z" });
    await w.d1.prepare("update events set is_completed = 1 where id = ?").bind(done.id).run();
    await createTask(w.ctx, w.amit, { title: "Ancient task", event_timestamp: "2031-04-30T01:00:00.000Z" });
    await createLead(w.ctx, w.amit, { client_name: "Milestone Only Ltd", renewal_date: "2031-05-02" });
    expect(await deliverTaskReminders(w.ctx, at("2031-05-01T06:00:00.000Z"))).toBe(0);
  });

  it("does not remind someone who has been disabled", async () => {
    const task = await createTask(w.ctx, w.admin, { title: "For a leaver", assigned_agent_id: w.neha.id, event_timestamp: "2031-06-01T06:00:00.000Z" });
    await w.d1.prepare("update profiles set is_active = 0 where id = ?").bind(w.neha.id).run();
    try {
      expect(await deliverTaskReminders(w.ctx, at("2031-06-01T06:00:00.000Z"))).toBe(0);
      expect((await bellFor(w.neha)).some((n) => n.title.includes("For a leaver"))).toBe(false);
      void task;
    } finally {
      await w.d1.prepare("update profiles set is_active = 1 where id = ?").bind(w.neha.id).run();
    }
  });
});

describe("renewal escalation to admins", () => {
  async function leadWithQuietAgent(name: string, renewal: string) {
    const id = await createLead(w.ctx, w.admin, { client_name: name, renewal_date: renewal, assigned_agent_id: w.amit.id });
    // Last touched long ago.
    await w.d1.prepare("update leads set updated_at = '2030-01-01T00:00:00.000Z' where id = ?").bind(id).run();
    const [t10] = await sqlRows<{ event_timestamp: string }>("select event_timestamp from events where lead_id = ? and milestone = 'T-10 Days'", id);
    return { id, t10: new Date(Date.parse(t10.event_timestamp) + 30_000) };
  }

  it("tells every admin when a T-10 reminder fires on a lead with no activity for 3 days", async () => {
    const { id, t10 } = await leadWithQuietAgent("Quiet Agent Co", "2031-08-20");
    await deliverDueReminders(w.ctx, t10);
    const adminBell = (await bellFor(w.admin)).filter((n) => n.lead_id === id);
    expect(adminBell).toHaveLength(1);
    expect(adminBell[0].title).toBe("No action in 3 days: Quiet Agent Co renewal (T-10 Days)");
    expect(adminBell[0].body).toContain("Amit Agent got the T-10 Days reminder");
    // The agent still gets the reminder itself.
    expect((await bellFor(w.amit)).some((n) => n.lead_id === id && n.kind === "renewal_reminder")).toBe(true);
    // Running again does not repeat it.
    await deliverDueReminders(w.ctx, t10);
    expect((await bellFor(w.admin)).filter((n) => n.lead_id === id)).toHaveLength(1);
  });

  it("does not escalate when the agent worked the lead in the last 3 days", async () => {
    const { id, t10 } = await leadWithQuietAgent("Busy Agent Co", "2031-08-21");
    // A note two days before the reminder.
    const note = await addLeadNote(w.ctx, w.amit, id, "Spoke to HR, quote next week");
    await w.d1.prepare("update lead_notes set created_at = ? where id = ?").bind(new Date(t10.getTime() - 2 * 86_400_000).toISOString(), note.id).run();
    await deliverDueReminders(w.ctx, t10);
    expect((await bellFor(w.admin)).some((n) => n.lead_id === id && n.title.startsWith("No action"))).toBe(false);
  });

  it("does not escalate earlier milestones such as T-30", async () => {
    const id = await createLead(w.ctx, w.admin, { client_name: "Early Days Co", renewal_date: "2031-09-30", assigned_agent_id: w.amit.id });
    await w.d1.prepare("update leads set updated_at = '2030-01-01T00:00:00.000Z' where id = ?").bind(id).run();
    const [t30] = await sqlRows<{ event_timestamp: string }>("select event_timestamp from events where lead_id = ? and milestone = 'T-30 Days'", id);
    await deliverDueReminders(w.ctx, new Date(Date.parse(t30.event_timestamp) + 30_000));
    expect((await bellFor(w.admin)).some((n) => n.lead_id === id)).toBe(false);
  });
});
