import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { addDays, todayInBusinessTz } from "@/lib/dates";

import { auditLogs, deletedLeads, events, leadNotes, leadTags, leads } from "../../db/schema";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { createTask, deleteTask } from "../events";
import { addLeadNote, createLead, deleteLead, setLeadTags } from "../leads";
import { listDeletedLeads, listExports, purgeDeletedLeads, recordExport, restoreDeletedLead } from "../data-safety";
import { testWorld } from "./helpers";

// Audit R10: deleted leads go to a bin and can be restored with everything
// that hung off them; every export of client data and every task delete
// leaves an audit row.

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

describe("deleted leads bin", () => {
  it("restores a deleted lead with its notes, tags and renewal countdown", async () => {
    const id = await createLead(w.ctx, w.admin, {
      client_name: "Bin Test Industries",
      renewal_date: addDays(todayInBusinessTz(), 40),
      assigned_agent_id: w.amit.id,
      notifyOwner: false,
    });
    await addLeadNote(w.ctx, w.amit, id, "Asked for the GMC census");
    await setLeadTags(w.ctx, w.amit, id, ["Hot"]);
    const eventsBefore = await w.ctx.db.select().from(events).where(eq(events.lead_id, id));
    expect(eventsBefore.length).toBeGreaterThan(0);

    await expect(deleteLead(w.ctx, w.amit, id)).rejects.toBeInstanceOf(AccessDeniedError);
    await deleteLead(w.ctx, w.admin, id);
    expect(await w.ctx.db.query.leads.findFirst({ where: eq(leads.id, id) })).toBeUndefined();
    expect(await w.ctx.db.select().from(leadNotes).where(eq(leadNotes.lead_id, id))).toEqual([]);

    const bin = await listDeletedLeads(w.ctx, w.admin);
    expect(bin).toEqual([expect.objectContaining({ lead_id: id, client_name: "Bin Test Industries", owner_name: "Amit Agent", notes: 1 })]);
    await expect(listDeletedLeads(w.ctx, w.amit)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(restoreDeletedLead(w.ctx, w.amit, id)).rejects.toBeInstanceOf(AccessDeniedError);

    expect(await restoreDeletedLead(w.ctx, w.admin, id)).toBe(id);
    const restored = await w.ctx.db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect(restored).toMatchObject({ client_name: "Bin Test Industries", assigned_agent_id: w.amit.id });
    const notes = await w.ctx.db.select().from(leadNotes).where(eq(leadNotes.lead_id, id));
    expect(notes.map((n) => n.content)).toEqual(["Asked for the GMC census"]);
    expect((await w.ctx.db.select().from(leadTags).where(eq(leadTags.lead_id, id))).map((t) => t.tag)).toEqual(["Hot"]);
    expect((await w.ctx.db.select().from(events).where(eq(events.lead_id, id))).length).toBe(eventsBefore.length);
    expect(await listDeletedLeads(w.ctx, w.admin)).toEqual([]);
    await expect(restoreDeletedLead(w.ctx, w.admin, id)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("empties the bin after 90 days", async () => {
    const id = await createLead(w.ctx, w.admin, { client_name: "Old Deleted Co" });
    await deleteLead(w.ctx, w.admin, id);
    expect(await purgeDeletedLeads(w.ctx)).toBe(0);
    await w.ctx.db.update(deletedLeads).set({ deleted_at: "2020-01-01T00:00:00.000Z" }).where(eq(deletedLeads.lead_id, id));
    expect(await purgeDeletedLeads(w.ctx)).toBe(1);
  });
});

describe("audit trail for exports and task deletes", () => {
  it("records every export and lists it for admins", async () => {
    await recordExport(w.ctx, w.admin, { report: "leads_filtered", rows: 42, filters: { status: "Quoted", q: "" } });
    const [latest] = await listExports(w.ctx, w.admin);
    expect(latest).toMatchObject({ actor_name: "Asha Admin", report: "Leads (filtered)", rows: 42, filters: { status: "Quoted" } });
    await expect(listExports(w.ctx, w.neha)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("writes an audit row when a task is deleted", async () => {
    const task = await createTask(w.ctx, w.neha, { title: "Call back Ravi", event_timestamp: new Date(Date.now() + 86_400_000).toISOString() });
    await deleteTask(w.ctx, w.neha, task.id);
    const rows = await w.ctx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.table_name, "events"), eq(auditLogs.record_id, String(task.id)), eq(auditLogs.action, "DELETE")));
    expect(rows).toEqual([expect.objectContaining({ actor_id: w.neha.id })]);
  });
});
