import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { addDays, addYears, todayInBusinessTz } from "@/lib/dates";
import { parseLeadFilters } from "@/lib/lead-filters";

import { auditLogs, events, leads } from "../../db/schema";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { listCalendarEvents } from "../events";
import {
  addLeadNote,
  countClosedLeadsToRoll,
  createLead,
  editLeadNote,
  getLeadPage,
  leadsForExport,
  leadsForFilteredExport,
  listLeads,
  rollForwardClosedLeads,
  setLeadStatus,
  updateLead,
} from "../leads";
import { deleteLeadTransaction, policyDocument, saveLeadTransaction } from "../transactions";
import { testWorld } from "./helpers";

// Ash's corrections (2026-11-17): Renewed status, the annual renewal rollover
// when a lead is closed, editable notes, transaction details with the policy
// copy on won/renewed leads, export filters, and product names on the calendar.

let w: Awaited<ReturnType<typeof testWorld>>;
const today = todayInBusinessTz();
const PDF = new TextEncoder().encode("%PDF-1.4\n% test policy\n");

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

const lead = async (id: number) => (await w.ctx.db.query.leads.findFirst({ where: eq(leads.id, id) }))!;
const systemEvents = (id: number) =>
  w.ctx.db.select().from(events).where(and(eq(events.lead_id, id), eq(events.is_system_generated, true)));

describe("closing a lead rolls the renewal to next year", () => {
  it("moves a soon-due renewal a year on and rebuilds the countdown for the new date", async () => {
    const due = addDays(today, 20);
    const id = await createLead(w.ctx, w.amit, { client_name: "Rollover Won Pvt Ltd", renewal_date: due, status: "Quoted" });
    await setLeadStatus(w.ctx, w.amit, id, "Closed Won");
    const after = await lead(id);
    expect(after.status).toBe("Closed Won");
    expect(after.renewal_date).toBe(addYears(due, 1));
    const rows = await systemEvents(id);
    const dueEvent = rows.find((e) => e.milestone === "DUE")!;
    expect(dueEvent.event_timestamp.slice(0, 4)).toBe(addYears(due, 1).slice(0, 4));
    // Every milestone is ahead again: T-30 days to T-5 minutes.
    expect(rows.filter((e) => e.is_background_reminder).map((e) => e.milestone)).toEqual(
      expect.arrayContaining(["T-30 Days", "T-10 Days", "T-24 Hours", "T-5 Minutes"]),
    );
  });

  it("uses the date the person confirmed, and does not roll twice when Closed Won is corrected to Renewed", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Confirmed Date Pvt Ltd", renewal_date: addDays(today, -10) });
    const chosen = addDays(today, 300);
    await setLeadStatus(w.ctx, w.amit, id, "Renewed", { renewalDate: chosen });
    expect((await lead(id)).renewal_date).toBe(chosen);
    await setLeadStatus(w.ctx, w.amit, id, "Closed Won");
    expect((await lead(id)).renewal_date).toBe(chosen);
    await expect(setLeadStatus(w.ctx, w.amit, id, "Closed Lost", { renewalDate: "2027-02-30" })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rolls a lost overdue lead so the team sees it next year, and leaves open statuses alone", async () => {
    const overdue = addDays(today, -40);
    const lost = await createLead(w.ctx, w.neha, { client_name: "Lost This Year Ltd", renewal_date: overdue });
    await setLeadStatus(w.ctx, w.neha, lost, "Closed Lost");
    expect((await lead(lost)).renewal_date).toBe(addYears(overdue, 1));

    const open = await createLead(w.ctx, w.neha, { client_name: "Still Chasing Ltd", renewal_date: overdue });
    await setLeadStatus(w.ctx, w.neha, open, "Follow-up");
    expect((await lead(open)).renewal_date).toBe(overdue);
  });

  it("rolls when the lead is closed on the edit form without touching the date", async () => {
    const due = addDays(today, 5);
    const id = await createLead(w.ctx, w.amit, { client_name: "Edit Form Close Ltd", renewal_date: due });
    await updateLead(w.ctx, w.amit, id, { status: "Renewed", renewal_date: due });
    expect((await lead(id)).renewal_date).toBe(addYears(due, 1));
  });

  it("lets admins catch up closed leads with past dates, 100 at a time; agents cannot", async () => {
    const old = addDays(today, -400);
    const id = await createLead(w.ctx, w.admin, { client_name: "Old Closed Won Ltd", renewal_date: old, assigned_agent_id: w.amit.id });
    // Closed before the rollover existed: written straight to the row.
    await w.ctx.db.update(leads).set({ status: "Closed Won" }).where(eq(leads.id, id));
    expect(await countClosedLeadsToRoll(w.ctx, w.admin)).toBeGreaterThanOrEqual(1);
    await expect(rollForwardClosedLeads(w.ctx, w.amit)).rejects.toBeInstanceOf(AccessDeniedError);
    const result = await rollForwardClosedLeads(w.ctx, w.admin);
    expect(result.remaining).toBe(0);
    const after = await lead(id);
    expect(after.renewal_date! > today).toBe(true);
    expect(after.renewal_date!.slice(5)).toBe(old.slice(5) === "02-29" ? "02-28" : old.slice(5));
    expect((await systemEvents(id)).some((e) => e.milestone === "DUE")).toBe(true);
  });
});

describe("editing notes", () => {
  it("lets the writer fix their note, marks it edited and keeps the old text in the audit log", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Note Edit Ltd" });
    const note = await addLeadNote(w.ctx, w.amit, id, "Called Rajesh, quote on Monday");
    const edited = await editLeadNote(w.ctx, w.amit, note.id, "Called Rajesh, quote on Tuesday");
    expect(edited.content).toBe("Called Rajesh, quote on Tuesday");
    expect(edited.edited_at).not.toBeNull();
    expect(edited.agent_name).toBe(note.agent_name);
    expect(edited.created_at).toBe(note.created_at);
    const audit = await w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.table_name, "lead_notes"), eq(auditLogs.record_id, String(note.id))));
    expect(audit.at(-1)?.old_data).toMatchObject({ content: "Called Rajesh, quote on Monday" });
  });

  it("stops agents editing someone else's note or a note on a lead that isn't theirs; admins can edit any", async () => {
    const id = await createLead(w.ctx, w.admin, { client_name: "Shared Notes Ltd", assigned_agent_id: w.amit.id });
    const adminNote = await addLeadNote(w.ctx, w.admin, id, "Admin briefing");
    await expect(editLeadNote(w.ctx, w.amit, adminNote.id, "Changed")).rejects.toBeInstanceOf(AccessDeniedError);
    const amitNote = await addLeadNote(w.ctx, w.amit, id, "Amit's call");
    await expect(editLeadNote(w.ctx, w.neha, amitNote.id, "Neha was here")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(editLeadNote(w.ctx, w.amit, amitNote.id, "   ")).rejects.toBeInstanceOf(InvalidInputError);
    expect((await editLeadNote(w.ctx, w.admin, amitNote.id, "Amit's call (corrected by admin)")).content).toBe(
      "Amit's call (corrected by admin)",
    );
  });
});

describe("transaction details on won and renewed leads", () => {
  let leadId: number;
  let txId: number;

  it("refuses transactions until the lead is Closed Won or Renewed", async () => {
    leadId = await createLead(w.ctx, w.amit, { client_name: "Transaction Co Pvt Ltd", renewal_date: addDays(today, 10) });
    await expect(
      saveLeadTransaction(w.ctx, w.amit, leadId, { transaction_date: today, policy_status: "Policy Yet to Receive" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("records the dates, then the received policy copy, readable only by those who see the lead", async () => {
    await setLeadStatus(w.ctx, w.amit, leadId, "Closed Won");
    const tx = await saveLeadTransaction(w.ctx, w.amit, leadId, {
      transaction_date: today,
      policy_start_date: addDays(today, 10),
      policy_status: "Policy Yet to Receive",
    });
    txId = tx.id;
    expect(tx).toMatchObject({ policy_status: "Policy Yet to Receive", policy_doc_path: null });
    await expect(
      saveLeadTransaction(w.ctx, w.amit, leadId, { id: txId, transaction_date: today, policy_status: "Policy Yet to Receive" }, { bytes: PDF, name: "p.pdf" }),
    ).rejects.toThrow(/received/);

    const received = await saveLeadTransaction(
      w.ctx,
      w.amit,
      leadId,
      { id: txId, transaction_date: today, policy_start_date: addDays(today, 10), policy_status: "Policy Received" },
      { bytes: PDF, name: "GMC policy 2026.pdf" },
    );
    expect(received.policy_doc_path).toMatch(new RegExp(`^policies/${leadId}/[0-9a-f-]{36}\\.pdf$`));
    expect(received.policy_doc_name).toBe("GMC policy 2026.pdf");
    expect((await policyDocument(w.ctx, w.amit, txId))?.contentType).toBe("application/pdf");
    expect(await policyDocument(w.ctx, w.neha, txId)).toBeNull();
    expect((await getLeadPage(w.ctx, w.amit, leadId))?.transactions.map((t) => t.id)).toEqual([txId]);
  });

  it("rejects files that are not a PDF or photo, future transaction dates, and other agents", async () => {
    await expect(
      saveLeadTransaction(w.ctx, w.amit, leadId, { transaction_date: today, policy_status: "Policy Received" }, {
        bytes: new TextEncoder().encode("<html>not a policy</html>"),
        name: "x.pdf",
      }),
    ).rejects.toThrow(/PDF/);
    await expect(
      saveLeadTransaction(w.ctx, w.amit, leadId, { transaction_date: addDays(today, 3), policy_status: "Policy Received" }),
    ).rejects.toThrow(/future/);
    await expect(
      saveLeadTransaction(w.ctx, w.neha, leadId, { transaction_date: today, policy_status: "Policy Received" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("filters and exports by closed outcome and policy start date; only admins export", async () => {
    const start = addDays(today, 10);
    const byStart = await listLeads(w.ctx, w.admin, parseLeadFilters({ start_from: start, start_to: start }));
    expect(byStart.leads.map((l) => l.id)).toEqual([leadId]);
    const outside = await listLeads(w.ctx, w.admin, parseLeadFilters({ start_from: addDays(today, 11) }));
    expect(outside.leads.map((l) => l.id)).not.toContain(leadId);

    const won = await listLeads(w.ctx, w.admin, parseLeadFilters({ outcome: "won" }));
    expect(won.leads.every((l) => l.status === "Closed Won" || l.status === "Renewed")).toBe(true);
    const lost = await listLeads(w.ctx, w.admin, parseLeadFilters({ outcome: "lost" }));
    expect(lost.leads.length).toBeGreaterThan(0);
    expect(lost.leads.every((l) => l.status === "Closed Lost")).toBe(true);

    const exported = await leadsForFilteredExport(w.ctx, w.admin, parseLeadFilters({ outcome: "won", start_from: start }));
    expect(exported.leads.map((l) => l.id)).toEqual([leadId]);
    expect(exported.leads[0].transaction).toEqual({ transaction_date: today, policy_start_date: start, policy_status: "Policy Received" });
    expect((await leadsForExport(w.ctx, w.admin, [leadId]))[0].transaction?.policy_status).toBe("Policy Received");
    await expect(leadsForFilteredExport(w.ctx, w.amit, parseLeadFilters({}))).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("lets only admins delete a transaction", async () => {
    await expect(deleteLeadTransaction(w.ctx, w.amit, txId)).rejects.toBeInstanceOf(AccessDeniedError);
    await deleteLeadTransaction(w.ctx, w.admin, txId);
    expect((await getLeadPage(w.ctx, w.admin, leadId))?.transactions).toEqual([]);
  });
});

describe("calendar product names", () => {
  it("labels each renewal with its lead's product", async () => {
    const fire = await createLead(w.ctx, w.amit, {
      client_name: "Fire Cover Ltd",
      policy_product: "Fire or Property",
      business_type: "Corporate",
      renewal_date: addDays(today, 15),
    });
    const gmc = await createLead(w.ctx, w.amit, {
      client_name: "Group Health Ltd",
      policy_product: "Health",
      business_type: "Corporate",
      renewal_date: addDays(today, 15),
    });
    const rows = await listCalendarEvents(w.ctx, w.amit, { from: `${today}T00:00:00.000Z`, to: `${addDays(today, 20)}T00:00:00.000Z` });
    const label = (id: number) => rows.find((e) => e.lead_id === id && e.milestone === "DUE")?.product_label;
    expect(label(fire)).toBe("Fire");
    expect(label(gmc)).toBe("GMC");
  });
});
