import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { leads, notifications, workTasks } from "../../db/schema";
import { AccessDeniedError } from "../errors";
import { createLead } from "../leads";
import { addPlaybookStep, createPlaybook, listPlaybooks, runPlaybooks, setPlaybookActive } from "../playbooks";
import { sendWhatsAppAlerts, setWhatsApp } from "../whatsapp";
import type { WhatsAppAlert } from "../../whatsapp/client";
import { testWorld } from "./helpers";

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
});
afterAll(async () => {
  await w.dispose();
});

/** The playbook reminders a lead's agent got, oldest first. */
const remindersFor = (leadId: number) =>
  w.ctx.db
    .select({ id: notifications.id, user_id: notifications.user_id, title: notifications.title, body: notifications.body, task_id: notifications.task_id })
    .from(notifications)
    .where(and(eq(notifications.lead_id, leadId), like(notifications.title, "Renewal step:%")))
    .orderBy(notifications.id);
const tasksFor = (leadId: number) => w.ctx.db.select({ id: workTasks.id }).from(workTasks).where(eq(workTasks.lead_id, leadId));

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

  it("reminds the lead's agent when each step's date comes, once per renewal, without Task Grid tasks", async () => {
    const at = new Date("2031-01-01T05:00:00.000Z"); // 1 Jan 2031, 10:30 IST
    const id = await createLead(w.ctx, w.admin, {
      client_name: "Acme Pvt Ltd",
      renewal_date: "2031-03-01", // 59 days away: step 1 (-60) is due 31 Dec, inside the 3-day grace
      assigned_agent_id: w.amit.id,
      business_type: "Corporate",
    });
    expect(await runPlaybooks(w.ctx, at)).toBe(0); // off

    await setPlaybookActive(w.ctx, w.admin, 1, true);
    expect(await runPlaybooks(w.ctx, at)).toBe(1);
    let sent = await remindersFor(id);
    expect(sent.map((r) => r.title)).toEqual(["Renewal step: Collect last policy and employee list from Acme Pvt Ltd"]);
    expect(sent[0]).toMatchObject({ user_id: w.amit.id, task_id: null });
    expect(sent[0]!.body).toMatch(/^Due 2030-12-31 · .* · Corporate renewal playbook, renewal 2031-03-01$/);
    expect(await tasksFor(id)).toHaveLength(0);

    // Same hour again: nothing new. 11 days later, step 2 (-45, opens 3 days early) is sent.
    expect(await runPlaybooks(w.ctx, at)).toBe(0);
    await runPlaybooks(w.ctx, new Date("2031-01-12T05:00:00.000Z"));
    sent = await remindersFor(id);
    expect(sent.map((r) => r.title)).toContain("Renewal step: Send Acme Pvt Ltd renewal to 3 insurers for quotes");

    // A lost lead gets no more steps.
    await w.ctx.db.update(leads).set({ status: "Closed Lost" }).where(eq(leads.id, id));
    await runPlaybooks(w.ctx, new Date("2031-02-01T05:00:00.000Z"));
    expect(await remindersFor(id)).toHaveLength(2);
    expect(await tasksFor(id)).toHaveLength(0);
  });

  it("skips steps long overdue, other business types, and leads with no agent", async () => {
    const at = new Date("2031-06-01T05:00:00.000Z");
    const late = await createLead(w.ctx, w.admin, { client_name: "Late Co", renewal_date: "2031-06-05", assigned_agent_id: w.neha.id, business_type: "Corporate" });
    const retail = await createLead(w.ctx, w.admin, { client_name: "Mr Retail", renewal_date: "2031-06-05", assigned_agent_id: w.neha.id, business_type: "Retail" });
    const nobody = await createLead(w.ctx, w.admin, { client_name: "Nobody Ltd", renewal_date: "2031-06-05", business_type: "Corporate" });
    await runPlaybooks(w.ctx, at);
    // Corporate, 4 days out: -10 (due 26 May) is too late; -3 (due 2 Jun) is open.
    expect((await remindersFor(late)).map((t) => t.title)).toEqual(["Renewal step: Renewal not confirmed yet: Late Co"]);
    expect(await remindersFor(retail)).toHaveLength(0); // retail playbook is still off
    expect(await remindersFor(nobody)).toHaveLength(0);
  });

  it("sends reminders to the agent's WhatsApp, where Done marks them read and Snooze sends again in an hour", async () => {
    await setWhatsApp(w.ctx, w.admin, w.amit.id, "98765 43210", true);
    const at = new Date("2031-09-01T05:00:00.000Z");
    const lead = await createLead(w.ctx, w.admin, { client_name: "Orbit Labs", renewal_date: "2031-09-04", assigned_agent_id: w.amit.id, business_type: "Corporate" });
    await runPlaybooks(w.ctx, at); // -3 step, due 1 Sep
    const [reminder] = await remindersFor(lead);
    expect(reminder).toBeTruthy();

    const out: WhatsAppAlert[] = [];
    const send = async (a: WhatsAppAlert) => {
      out.push(a);
      return { ok: true as const, id: `wamid.pb.${out.length}` };
    };
    const soon = new Date(at.getTime() + 60_000);
    expect(await sendWhatsAppAlerts(w.ctx, send, soon)).toBe(1);
    expect(out[0]).toMatchObject({
      to: "919876543210",
      title: "Renewal step: Renewal not confirmed yet: Orbit Labs",
      taskId: 0,
      buttons: [`seen:${reminder!.id}`, `later:${reminder!.id}`],
    });
    expect(await sendWhatsAppAlerts(w.ctx, send, soon)).toBe(0);

    const { handleWhatsAppReply } = await import("../whatsapp");
    // Someone else's reminder id does nothing to it.
    await setWhatsApp(w.ctx, w.admin, w.neha.id, "98000 00002", true);
    expect(await handleWhatsAppReply(w.ctx, { from: "919800000002", payload: `seen:${reminder!.id}` }, {}, soon)).toMatch(/couldn't find/);

    expect(await handleWhatsAppReply(w.ctx, { from: "919876543210", payload: `later:${reminder!.id}` }, { appUrl: "https://lms.test" }, soon)).toMatch(
      /Snoozed.*lms\.test\/leads\//,
    );
    expect(await sendWhatsAppAlerts(w.ctx, send, new Date(soon.getTime() + 30 * 60_000))).toBe(0);
    expect(await sendWhatsAppAlerts(w.ctx, send, new Date(soon.getTime() + 61 * 60_000))).toBe(1);
    expect(out[1]!.title).toBe(out[0]!.title);

    // A typed "done" swiped on the re-sent reminder marks it read.
    expect(await handleWhatsAppReply(w.ctx, { from: "919876543210", text: "done", contextId: "wamid.pb.2" }, {}, soon)).toMatch(/^Noted/);
    const row = await w.ctx.db.query.notifications.findFirst({ where: eq(notifications.id, reminder!.id) });
    expect(row?.read_at).toBeTruthy();
    expect(await tasksFor(lead)).toHaveLength(0);
  });

  it("lets admins build their own playbook", async () => {
    const id = await createPlaybook(w.ctx, w.admin, "Motor renewal", "Retail");
    await addPlaybookStep(w.ctx, w.admin, id, { day_offset: -7, title: "Ask {client} for the RC copy", description: "Needed for the {client} quote" });
    await setPlaybookActive(w.ctx, w.admin, id, true);
    const lead = await createLead(w.ctx, w.admin, { client_name: "Ravi", renewal_date: "2031-08-10", assigned_agent_id: w.amit.id, business_type: "Retail" });
    await runPlaybooks(w.ctx, new Date("2031-08-01T05:00:00.000Z"));
    const rows = await remindersFor(lead);
    expect(rows.map((r) => r.title)).toEqual(["Renewal step: Ask Ravi for the RC copy"]);
    expect(rows[0]!.body).toContain("Needed for the Ravi quote");
  });
});
