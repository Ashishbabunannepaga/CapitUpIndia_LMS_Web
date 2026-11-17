import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { addDays, todayInBusinessTz } from "@/lib/dates";
import { canBeOverdue } from "@/lib/domain";
import { parseLeadFilters } from "@/lib/lead-filters";

import { leads } from "../../db/schema";
import { pipelineAnalytics } from "../analytics";
import { createLead, listLeads } from "../leads";
import { myDay } from "../my-day";
import { testWorld } from "./helpers";

// Ash (2026-11-17): Closed Won leads still showed as overdue. A won, renewed or
// lost lead has finished this cycle, so its past renewal date is never overdue.

let w: Awaited<ReturnType<typeof testWorld>>;
const today = todayInBusinessTz();
const past = addDays(today, -15);

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

/** A lead already in `status` with last cycle's date (as live leads closed before the rollover are). */
async function closedWithPastDate(name: string, status: "Closed Won" | "Renewed" | "Closed Lost") {
  const id = await createLead(w.ctx, w.amit, { client_name: name, status: "Quoted" });
  await w.ctx.db.update(leads).set({ status, renewal_date: past }).where(eq(leads.id, id));
  return id;
}

describe("closed leads are never overdue", () => {
  it("counts only open leads as overdue in the list filter, My Day and analytics", async () => {
    const [dayBefore, statsBefore] = await Promise.all([myDay(w.ctx, w.amit), pipelineAnalytics(w.ctx, w.admin)]);

    const won = await closedWithPastDate("Won Last Year Pvt Ltd", "Closed Won");
    const renewed = await closedWithPastDate("Renewed Last Year Pvt Ltd", "Renewed");
    const lost = await closedWithPastDate("Lost Last Year Pvt Ltd", "Closed Lost");
    const open = await createLead(w.ctx, w.amit, { client_name: "Still Open Pvt Ltd", status: "Quoted", renewal_date: past });

    const overdue = (await listLeads(w.ctx, w.amit, parseLeadFilters({ renewal: "overdue" }))).leads.map((l) => l.id);
    expect(overdue).toContain(open);
    expect(overdue).not.toContain(won);
    expect(overdue).not.toContain(renewed);
    expect(overdue).not.toContain(lost);

    const day = await myDay(w.ctx, w.amit);
    expect(day.counts.overdueRenewals).toBe(dayBefore.counts.overdueRenewals + 1);
    expect(day.overdueRenewals.map((l) => l.id)).toEqual(expect.arrayContaining([open]));
    expect(day.overdueRenewals.map((l) => l.id)).not.toEqual(expect.arrayContaining([won]));
    expect(day.overdueRenewals.map((l) => l.id)).not.toEqual(expect.arrayContaining([renewed]));

    const stats = await pipelineAnalytics(w.ctx, w.admin);
    expect(stats.renewals.overdue).toBe(statsBefore.renewals.overdue + 1);
    const agentOverdue = (s: typeof stats) => s.agents.reduce((n, a) => n + a.overdue_renewals, 0);
    expect(agentOverdue(stats)).toBe(agentOverdue(statsBefore) + 1);
  });

  it("still lists upcoming renewals of won and renewed clients", async () => {
    const soon = addDays(today, 5);
    const id = await createLead(w.ctx, w.amit, { client_name: "Upcoming Won Pvt Ltd", status: "Quoted" });
    await w.ctx.db.update(leads).set({ status: "Closed Won", renewal_date: soon }).where(eq(leads.id, id));
    const day = await myDay(w.ctx, w.amit);
    expect(day.renewals.map((l) => l.id)).toContain(id);
  });

  it("knows which statuses can be overdue", () => {
    expect(["Closed Won", "Renewed", "Closed Lost"].map(canBeOverdue)).toEqual([false, false, false]);
    expect(["Prospect", "Quoted", "Follow-up"].map(canBeOverdue)).toEqual([true, true, true]);
  });
});
