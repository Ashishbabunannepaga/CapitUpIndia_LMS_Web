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

// 2026-11-20: Closed Won is a client whose policy year runs to its renewal
// date. Once that date passes without a new policy it is overdue again (the
// renewal is due). Leads waiting for their policy, auto-renewing and lost
// leads are never overdue.

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
async function closedWithPastDate(name: string, status: "Closed Won" | "Closed Awaiting Policy" | "Auto Renewed" | "Closed Lost") {
  const id = await createLead(w.ctx, w.amit, { client_name: name, status: "Quoted" });
  await w.ctx.db.update(leads).set({ status, renewal_date: past }).where(eq(leads.id, id));
  return id;
}

describe("which closed leads are overdue", () => {
  it("counts only open leads as overdue in the list filter, My Day and analytics", async () => {
    const [dayBefore, statsBefore] = await Promise.all([myDay(w.ctx, w.amit), pipelineAnalytics(w.ctx, w.admin)]);

    const won = await closedWithPastDate("Won Last Year Pvt Ltd", "Closed Won");
    const awaiting = await closedWithPastDate("Awaiting Policy Pvt Ltd", "Closed Awaiting Policy");
    const auto = await closedWithPastDate("Auto Renews Pvt Ltd", "Auto Renewed");
    const lost = await closedWithPastDate("Lost Last Year Pvt Ltd", "Closed Lost");
    const open = await createLead(w.ctx, w.amit, { client_name: "Still Open Pvt Ltd", status: "Quoted", renewal_date: past });

    const overdue = (await listLeads(w.ctx, w.amit, parseLeadFilters({ renewal: "overdue" }))).leads.map((l) => l.id);
    expect(overdue).toContain(open);
    expect(overdue).toContain(won);
    expect(overdue).not.toContain(awaiting);
    expect(overdue).not.toContain(auto);
    expect(overdue).not.toContain(lost);

    const day = await myDay(w.ctx, w.amit);
    expect(day.counts.overdueRenewals).toBe(dayBefore.counts.overdueRenewals + 2);
    expect(day.overdueRenewals.map((l) => l.id)).toEqual(expect.arrayContaining([open, won]));
    expect(day.overdueRenewals.map((l) => l.id)).not.toEqual(expect.arrayContaining([awaiting]));
    expect(day.overdueRenewals.map((l) => l.id)).not.toEqual(expect.arrayContaining([auto]));

    const stats = await pipelineAnalytics(w.ctx, w.admin);
    expect(stats.renewals.overdue).toBe(statsBefore.renewals.overdue + 2);
    const agentOverdue = (s: typeof stats) => s.agents.reduce((n, a) => n + a.overdue_renewals, 0);
    expect(agentOverdue(stats)).toBe(agentOverdue(statsBefore) + 2);
  });

  it("still lists upcoming renewals of won clients", async () => {
    const soon = addDays(today, 5);
    const id = await createLead(w.ctx, w.amit, { client_name: "Upcoming Won Pvt Ltd", status: "Quoted" });
    await w.ctx.db.update(leads).set({ status: "Closed Won", renewal_date: soon }).where(eq(leads.id, id));
    const day = await myDay(w.ctx, w.amit);
    expect(day.renewals.map((l) => l.id)).toContain(id);
  });

  it("knows which statuses can be overdue", () => {
    expect(["Closed Awaiting Policy", "Auto Renewed", "Closed Lost"].map(canBeOverdue)).toEqual([false, false, false]);
    expect(["Prospect", "Quoted", "Follow-up", "Closed Won"].map(canBeOverdue)).toEqual([true, true, true, true]);
  });
});
