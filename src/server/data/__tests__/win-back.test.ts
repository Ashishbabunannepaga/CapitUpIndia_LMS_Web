import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { addDays, todayInBusinessTz } from "@/lib/dates";

import { leadNotes, leads, notifications } from "../../db/schema";
import { createLead } from "../leads";
import { WIN_BACK_DAYS, isWinBackBlocked, winBackLostLeads } from "../win-back";
import { testWorld } from "./helpers";

// Audit R7 (Ash, 2026-11-27): a lost client's renewal rolls a year, and this
// many days before it the lead reopens as a Prospect so its reminders reach
// the agent again. Deceased clients and do-not-contact clients stay closed.

let w: Awaited<ReturnType<typeof testWorld>>;
const today = todayInBusinessTz();

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

async function lostLead(name: string, renewal: string, extra: Partial<typeof leads.$inferInsert> = {}, owner: string | null = w.amit.id) {
  const id = await createLead(w.ctx, w.admin, { client_name: name, renewal_date: renewal, assigned_agent_id: owner, notifyOwner: false });
  await w.ctx.db
    .update(leads)
    .set({ status: "Closed Lost", lost_reason: "Price", lost_reason_detail: "Went cheaper", ...extra })
    .where(eq(leads.id, id));
  return id;
}

const lead = async (id: number) => (await w.ctx.db.query.leads.findFirst({ where: eq(leads.id, id) }))!;

describe("win-back of lost clients", () => {
  it("reopens a lost lead whose renewal is near, with a note and one bell message", async () => {
    const id = await lostLead("Winback Textiles", addDays(today, 30));
    const far = await lostLead("Far Away Foods", addDays(today, WIN_BACK_DAYS + 40));

    expect(await winBackLostLeads(w.ctx)).toBe(1);
    const reopened = await lead(id);
    expect([reopened.status, reopened.type, reopened.lost_reason]).toEqual(["Prospect", "Renewal", ""]);
    expect((await lead(far)).status).toBe("Closed Lost");

    const notes = await w.ctx.db.select().from(leadNotes).where(eq(leadNotes.lead_id, id));
    expect(notes.some((n) => n.content.startsWith("[Win-back]") && n.content.includes("Price: Went cheaper"))).toBe(true);
    const bell = await w.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.user_id, w.amit.id), eq(notifications.lead_id, id)));
    expect(bell.map((n) => n.title)).toEqual(["Win-back: Winback Textiles renews soon"]);

    // Already reopened: a second run changes nothing.
    expect(await winBackLostLeads(w.ctx)).toBe(0);
  });

  it("never reopens deceased or do-not-contact clients", async () => {
    const deceased = await lostLead("Late Client Traders", addDays(today, 20), { lost_reason: "Client Deceased", lost_reason_detail: "" });
    const withdrawn = await lostLead("Consent Withdrawn Co", addDays(today, 20), {
      lost_reason: "Other",
      lost_reason_detail: "Withdrew consent in the CapitUp app",
    });
    expect(await winBackLostLeads(w.ctx)).toBe(0);
    expect((await lead(deceased)).status).toBe("Closed Lost");
    expect((await lead(withdrawn)).status).toBe("Closed Lost");
    expect(isWinBackBlocked({ lost_reason: "Price", lost_reason_detail: "", notes: "[App] Do not contact: the client withdrew" })).toBe(true);
  });

  it("tells the admins when the lead has no owner", async () => {
    const id = await lostLead("Orphan Lost Pvt Ltd", addDays(today, 10), {}, null);
    expect(await winBackLostLeads(w.ctx)).toBe(1);
    const bell = await w.ctx.db.select().from(notifications).where(eq(notifications.user_id, w.admin.id));
    expect(bell.some((n) => n.lead_id === id && n.title.startsWith("Win-back"))).toBe(true);
  });
});
