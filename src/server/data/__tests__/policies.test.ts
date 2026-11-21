import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { addDays, addYears, todayInBusinessTz } from "@/lib/dates";
import { parseLeadFilters } from "@/lib/lead-filters";
import { cleanPolicyReading } from "@/lib/policy-check";

import { events, leadTransactions, leads } from "../../db/schema";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { createLead, getLeadPage, listLeads, rollAutoRenewals, setLeadStatus } from "../leads";
import { confirmPolicy, discardPolicyUpload, pendingPolicyFor, reviewPolicy, savePolicyReading, uploadPolicy } from "../policies";
import { policyDocument } from "../transactions";
import { testWorld } from "./helpers";

// Ash (2026-11-20): agents close a lead as Closed Won only with its policy.
// Upload -> Closed Awaiting Policy -> AI reading -> checks -> confirm, which
// gives the client code for the policy year and moves the renewal date to the
// policy's end. Next year's policy keeps the client number with the new year.
// Auto Renewed retail term life rolls itself; Travel is one-time.

let w: Awaited<ReturnType<typeof testWorld>>;
const today = todayInBusinessTz();
const PDF = new TextEncoder().encode("%PDF-1.4\n% test policy\n");
const file = { bytes: PDF, name: "Sharma GMC 2026.pdf" };

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

const lead = async (id: number) => (await w.ctx.db.query.leads.findFirst({ where: eq(leads.id, id) }))!;
const row = async (id: number) => (await w.ctx.db.query.leadTransactions.findFirst({ where: eq(leadTransactions.id, id) }))!;
const systemEvents = (id: number) =>
  w.ctx.db.select().from(events).where(and(eq(events.lead_id, id), eq(events.is_system_generated, true)));

function readingFor(start: string, end: string, extra: Record<string, unknown> = {}) {
  return cleanPolicyReading({
    insured_name: "Sharma Textiles Private Limited",
    insurer: "Star Health",
    policy_number: "P/161/123",
    policy_product: "Health",
    plan_name: "Group Mediclaim",
    policy_start_date: start,
    policy_end_date: end,
    premium: 45000,
    sum_insured: 500000,
    ...extra,
  });
}

describe("closing a lead with its policy", () => {
  let leadId: number;
  let firstCode: string;
  const due = addDays(today, 10);
  const end = addDays(addYears(due, 1), -1);

  it("stops agents picking Closed Won without a policy; admins can still override", async () => {
    leadId = await createLead(w.ctx, w.amit, {
      client_name: "Sharma Textiles Pvt Ltd",
      business_type: "Corporate",
      policy_product: "Health",
      renewal_date: due,
      status: "Quoted",
    });
    await expect(setLeadStatus(w.ctx, w.amit, leadId, "Closed Won")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(createLead(w.ctx, w.amit, { client_name: "Sneaky Won Ltd", status: "Closed Won" })).rejects.toBeInstanceOf(AccessDeniedError);
    expect((await lead(leadId)).status).toBe("Quoted");
  });

  it("stores the upload as pending and marks the lead Closed Awaiting Policy; other agents can't touch it", async () => {
    const { row: pending, mime } = await uploadPolicy(w.ctx, w.amit, leadId, file, { premium: "45,000" });
    expect(mime).toBe("application/pdf");
    expect(pending).toMatchObject({ verification: "pending", kind: "won", premium: 45000, product: "Health" });
    expect(pending.policy_doc_path).toMatch(new RegExp(`^policies/${leadId}/`));
    expect((await lead(leadId)).status).toBe("Closed Awaiting Policy");
    expect((await pendingPolicyFor(w.ctx, w.amit, leadId))?.id).toBe(pending.id);

    await expect(uploadPolicy(w.ctx, w.neha, leadId, file)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(reviewPolicy(w.ctx, w.neha, pending.id)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(confirmPolicy(w.ctx, w.neha, pending.id, {})).rejects.toBeInstanceOf(InvalidInputError);
    expect(await policyDocument(w.ctx, w.neha, pending.id)).toBeNull();
    await expect(uploadPolicy(w.ctx, w.amit, leadId, { bytes: new TextEncoder().encode("<html>"), name: "x.pdf" })).rejects.toThrow(/PDF/);
  });

  it("a second upload replaces the unconfirmed one", async () => {
    const first = (await pendingPolicyFor(w.ctx, w.amit, leadId))!;
    const { row: second } = await uploadPolicy(w.ctx, w.amit, leadId, file, { premium: "45000" });
    expect(second.id).not.toBe(first.id);
    const pending = await w.ctx.db.select().from(leadTransactions).where(and(eq(leadTransactions.lead_id, leadId), eq(leadTransactions.verification, "pending")));
    expect(pending.map((r) => r.id)).toEqual([second.id]);
  });

  it("fills empty values from the reading and checks them against the lead", async () => {
    const pending = (await pendingPolicyFor(w.ctx, w.amit, leadId))!;
    const filled = await savePolicyReading(w.ctx, w.amit, pending.id, readingFor(due, end));
    expect(filled).toMatchObject({ policy_start_date: due, policy_end_date: end, premium: 45000, insurer: "Star Health", policy_number: "P/161/123" });
    const review = await reviewPolicy(w.ctx, w.amit, pending.id);
    expect(review.checks.every((c) => c.result === "match")).toBe(true);
    expect(review.oneTime).toBe(false);
  });

  it("needs differences acknowledged, and valid dates", async () => {
    const pending = (await pendingPolicyFor(w.ctx, w.amit, leadId))!;
    const values = { policy_start_date: due, policy_end_date: end, premium: 90000, policy_number: "P/161/123" };
    await expect(confirmPolicy(w.ctx, w.amit, pending.id, values)).rejects.toThrow(/differs/);
    await expect(confirmPolicy(w.ctx, w.amit, pending.id, { ...values, policy_end_date: "" })).rejects.toThrow(/end date/);
    await expect(confirmPolicy(w.ctx, w.amit, pending.id, { ...values, policy_end_date: due })).rejects.toThrow(/after its start/);
    expect((await lead(leadId)).status).toBe("Closed Awaiting Policy");
  });

  it("confirming makes the lead Closed Won with a client code for the policy year and next year's renewal", async () => {
    const pending = (await pendingPolicyFor(w.ctx, w.amit, leadId))!;
    const { client_code } = await confirmPolicy(w.ctx, w.amit, pending.id, {
      policy_start_date: due,
      policy_end_date: end,
      premium: "45,000",
      policy_number: "P/161/123",
      insurer: "Star Health",
    });
    firstCode = client_code;
    expect(client_code).toMatch(new RegExp(`^CAP-CLI-${due.slice(0, 4)}-\\d{4}$`));
    const after = await lead(leadId);
    expect(after).toMatchObject({ status: "Closed Won", renewal_date: end, client_code });
    expect(after.client_no).toBeGreaterThan(0);
    expect(await row(pending.id)).toMatchObject({
      verification: "verified",
      client_code,
      previous_renewal_date: due,
      next_renewal_date: end,
      confirmed_by: w.amit.id,
    });
    // Last year's due date stays on the calendar as a completed "Won" entry; the countdown is for the new date.
    const rows = await systemEvents(leadId);
    const kept = rows.find((e) => e.milestone === `DONE ${due}`)!;
    expect(kept).toMatchObject({ is_completed: true });
    expect(kept.title).toContain(client_code);
    expect(kept.title).toMatch(/^Won: /);
    expect(rows.find((e) => e.milestone === "DUE")!.event_timestamp.slice(0, 10)).toBe(end);
    await expect(confirmPolicy(w.ctx, w.amit, pending.id, {})).rejects.toThrow(/no longer waiting/);
  });

  it("next year's policy keeps the client number with the new year, kept beside last year's in Policy history", async () => {
    // The client stays Closed Won while the new year's policy is checked.
    const { row: pending } = await uploadPolicy(w.ctx, w.amit, leadId, file);
    expect(pending.kind).toBe("renewal");
    expect((await lead(leadId)).status).toBe("Closed Won");
    const nextStart = addDays(end, 1);
    const nextEnd = addDays(addYears(nextStart, 1), -1);
    await savePolicyReading(w.ctx, w.amit, pending.id, readingFor(nextStart, nextEnd, { premium: 52000 }));
    await expect(confirmPolicy(w.ctx, w.amit, pending.id, { policy_start_date: nextStart, policy_end_date: nextEnd, premium: 48000 })).rejects.toThrow(/differs/);
    const { client_code } = await confirmPolicy(
      w.ctx,
      w.amit,
      pending.id,
      { policy_start_date: nextStart, policy_end_date: nextEnd, premium: 48000, policy_number: "P/161/123" },
      true,
    );
    expect(client_code).toBe(`CAP-CLI-${nextStart.slice(0, 4)}-${firstCode.slice(-4)}`);
    expect(await row(pending.id)).toMatchObject({ verification: "differences", kind: "renewal" });
    const page = await getLeadPage(w.ctx, w.amit, leadId);
    expect(page!.transactions.map((t) => t.client_code).sort()).toEqual([firstCode, client_code].sort());
    expect((await lead(leadId)).renewal_date).toBe(nextEnd);
  });

  it("a discarded upload leaves the lead as it was; with no reading the year is marked checked by hand", async () => {
    const { row: pending } = await uploadPolicy(w.ctx, w.amit, leadId, file);
    await discardPolicyUpload(w.ctx, w.amit, pending.id);
    expect(await pendingPolicyFor(w.ctx, w.amit, leadId)).toBeNull();
    expect((await lead(leadId)).status).toBe("Closed Won");

    const other = await createLead(w.ctx, w.amit, { client_name: "Manual Check Ltd", policy_product: "Motor", business_type: "Retail" });
    const { row: upload } = await uploadPolicy(w.ctx, w.amit, other, file);
    await confirmPolicy(w.ctx, w.amit, upload.id, { policy_start_date: today, policy_end_date: addDays(addYears(today, 1), -1) });
    expect((await row(upload.id)).verification).toBe("manual");
  });

  it("finds a lead by its lead code and a client by any year's code", async () => {
    const byLead = await listLeads(w.ctx, w.amit, parseLeadFilters({ q: `LEAD-${String(leadId).padStart(4, "0")}` }));
    expect(byLead.leads.map((l) => l.id)).toEqual([leadId]);
    const byOldCode = await listLeads(w.ctx, w.amit, parseLeadFilters({ q: firstCode }));
    expect(byOldCode.leads.map((l) => l.id)).toEqual([leadId]);
    expect((await listLeads(w.ctx, w.neha, parseLeadFilters({ q: firstCode }))).leads).toEqual([]);
  });
});

describe("Auto Renewed and Travel", () => {
  it("allows Auto Renewed only on retail term life, giving a client code at once", async () => {
    await expect(
      createLead(w.ctx, w.amit, { client_name: "Corporate Auto Ltd", business_type: "Corporate", policy_product: "Life", status: "Auto Renewed" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    const id = await createLead(w.ctx, w.amit, {
      client_name: "Ravi Kumar",
      business_type: "Retail",
      policy_product: "Life",
      renewal_date: addDays(today, 30),
      status: "Auto Renewed",
    });
    const after = await lead(id);
    expect(after.client_code).toMatch(/^CAP-CLI-\d{4}-\d{4}$/);
    // Auto-renewing policies keep only their due date on the calendar (no countdown to chase).
    const rows = await systemEvents(id);
    expect(rows.map((e) => e.milestone)).toEqual(["DUE"]);
    expect(rows[0].title).toMatch(/^Auto-renews: /);
  });

  it("rolls a passed Auto Renewed policy to next year with the new year's code, kept in Policy history", async () => {
    const past = addDays(today, -3);
    const id = await createLead(w.ctx, w.amit, {
      client_name: "Priya Nair",
      business_type: "Retail",
      policy_product: "Life",
      renewal_date: past,
      status: "Auto Renewed",
    });
    const before = await lead(id);
    expect(await rollAutoRenewals(w.ctx, today)).toBeGreaterThanOrEqual(1);
    const after = await lead(id);
    expect(after.renewal_date).toBe(addYears(past, 1));
    expect(after.client_no).toBe(before.client_no);
    expect(after.client_code).toBe(`CAP-CLI-${past.slice(0, 4)}-${String(before.client_no).padStart(4, "0")}`);
    const history = await w.ctx.db.select().from(leadTransactions).where(eq(leadTransactions.lead_id, id));
    expect(history.map((r) => r.kind).sort()).toEqual(["auto_renewed", "won"]);
    expect((await systemEvents(id)).find((e) => e.milestone === `DONE ${past}`)?.title).toMatch(/^Auto-renewed: /);
    // Nothing left to roll.
    expect(await rollAutoRenewals(w.ctx, today)).toBe(0);
  });

  it("gives Travel no renewal date or reminders, and accepts a short policy", async () => {
    const id = await createLead(w.ctx, w.amit, {
      client_name: "Anita Trip",
      business_type: "Retail",
      policy_product: "Travel",
      renewal_date: addDays(today, 40),
    });
    expect((await lead(id)).renewal_date).toBeNull();
    expect(await systemEvents(id)).toEqual([]);
    const { row: upload } = await uploadPolicy(w.ctx, w.amit, id, file);
    expect((await reviewPolicy(w.ctx, w.amit, upload.id)).oneTime).toBe(true);
    await confirmPolicy(w.ctx, w.amit, upload.id, { policy_start_date: today, policy_end_date: addDays(today, 14) });
    expect(await lead(id)).toMatchObject({ status: "Closed Won", renewal_date: null });
    expect(await systemEvents(id)).toEqual([]);
  });
});
