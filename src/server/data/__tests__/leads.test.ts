import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseLeadFilters } from "@/lib/lead-filters";

import { AccessDeniedError, InvalidInputError } from "../errors";
import {
  addLeadContact,
  addLeadNote,
  assignLead,
  countLeadsByStatus,
  countUnreadLeadNotes,
  createLead,
  deleteLead,
  deleteLeadNote,
  getLead,
  getLeadEvents,
  getLeadNotes,
  listLeads,
  markLeadNotesRead,
  resolveDuplicate,
  setLeadStatus,
  unreadLeadNotes,
  updateLead,
} from "../leads";
import { findSimilarLeads, nameScore, similarity, trigrams } from "../duplicates";
import { createTask, deleteTask, listEvents, setEventDone } from "../events";
import { deliverDueReminders, markNotificationsRead, recentNotifications } from "../notifications";
import { setActive } from "../users";
import { testWorld } from "./helpers";

// Leads, notes, contacts, duplicates, renewal reminders and tasks on D1:
// the cases from supabase/tests/access_control.test.sql and edge_cases.test.sql.

let w: Awaited<ReturnType<typeof testWorld>>;
const filters = (q: Record<string, string> = {}) => parseLeadFilters(q);
const sqlRows = async <T>(query: string, ...binds: unknown[]) =>
  (await w.d1.prepare(query).bind(...binds).all<T>()).results;

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

describe("who sees which lead", () => {
  let amitLead: number;
  let nehaLead: number;

  beforeAll(async () => {
    amitLead = await createLead(w.ctx, w.amit, { client_name: "Amit Own Co" });
    nehaLead = await createLead(w.ctx, w.neha, { client_name: "Neha Own Co", notes: "Neha's secret" });
  });

  it("agents see only their leads, admins see all", async () => {
    const mine = (await listLeads(w.ctx, w.amit, filters())).leads.map((l) => l.client_name);
    expect(mine).toContain("Amit Own Co");
    expect(mine).not.toContain("Neha Own Co");
    const all = (await listLeads(w.ctx, w.admin, filters())).leads.map((l) => l.client_name);
    expect(all).toEqual(expect.arrayContaining(["Amit Own Co", "Neha Own Co"]));
  });

  it("a lead id from someone else returns nothing and changes nothing", async () => {
    expect(await getLead(w.ctx, w.amit, nehaLead)).toBeNull();
    await expect(getLeadNotes(w.ctx, w.amit, nehaLead)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(getLeadEvents(w.ctx, w.amit, nehaLead)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(updateLead(w.ctx, w.amit, nehaLead, { notes: "hijacked" })).rejects.toThrow("isn't yours");
    await expect(setLeadStatus(w.ctx, w.amit, nehaLead, "Quoted")).rejects.toThrow("isn't yours");
    await expect(addLeadNote(w.ctx, w.amit, nehaLead, "spy")).rejects.toThrow("isn't yours");
    await expect(addLeadContact(w.ctx, w.amit, nehaLead, { name: "Spy" })).rejects.toThrow("isn't yours");
    expect((await getLead(w.ctx, w.admin, nehaLead))?.notes).toBe("Neha's secret");
  });

  it("a deleted lead looks the same as one you cannot see", async () => {
    expect(await getLead(w.ctx, w.admin, 999_999)).toBeNull();
  });

  it("agents create leads only for themselves", async () => {
    await expect(createLead(w.ctx, w.amit, { client_name: "Gift Co", assigned_agent_id: w.neha.id })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    const id = await createLead(w.ctx, w.amit, { client_name: "Self Co", assigned_agent_id: null });
    expect((await getLead(w.ctx, w.amit, id))?.assigned_agent_id).toBe(w.amit.id);
  });

  it("agents cannot reassign, unassign, resolve or delete", async () => {
    await expect(updateLead(w.ctx, w.amit, amitLead, { assigned_agent_id: w.neha.id })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(updateLead(w.ctx, w.amit, amitLead, { assigned_agent_id: null })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(assignLead(w.ctx, w.amit, amitLead, w.neha.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(resolveDuplicate(w.ctx, w.amit, amitLead)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(deleteLead(w.ctx, w.amit, amitLead)).rejects.toBeInstanceOf(AccessDeniedError);
    expect((await getLead(w.ctx, w.admin, amitLead))?.assigned_agent_id).toBe(w.amit.id);
  });

  it("server-owned fields cannot be forged through the form fields", async () => {
    const id = await createLead(w.ctx, w.amit, {
      client_name: "Forged Co",
      ...({ is_duplicate: true, duplicate_label: "x", created_by: w.neha.id, created_at: "2000-01-01T00:00:00.000Z", assigned_at: "2000-01-01" } as object),
    });
    const lead = await getLead(w.ctx, w.admin, id);
    expect(lead).toMatchObject({ is_duplicate: false, duplicate_label: "", created_by: w.amit.id });
    expect(lead!.created_at > "2026").toBe(true);
    expect(lead!.assigned_at! > "2026").toBe(true);
  });

  it("agents can change their own lead's status; unknown statuses are refused", async () => {
    await setLeadStatus(w.ctx, w.amit, amitLead, "Quoted");
    expect((await getLead(w.ctx, w.amit, amitLead))?.status).toBe("Quoted");
    await expect(setLeadStatus(w.ctx, w.amit, amitLead, "Won")).rejects.toThrow("Unknown status.");
  });

  it("admins delete a lead with its notes and events, and the deletion is audited", async () => {
    const id = await createLead(w.ctx, w.admin, { client_name: "Doomed Co", assigned_agent_id: w.amit.id, renewal_date: "2031-01-15" });
    await addLeadNote(w.ctx, w.amit, id, "about to go");
    await deleteLead(w.ctx, w.admin, id);
    expect(await sqlRows("select id from events where lead_id = ?", id)).toEqual([]);
    expect(await sqlRows("select id from lead_notes where lead_id = ?", id)).toEqual([]);
    const audit = await sqlRows<{ action: string; actor_id: string }>(
      "select action, actor_id from audit_logs where table_name = 'leads' and record_id = ? order by id",
      String(id),
    );
    expect(audit.map((a) => a.action)).toEqual(["INSERT", "DELETE"]);
    expect(audit[1].actor_id).toBe(w.admin.id);
  });
});

describe("lead fields", () => {
  it("trims names, lowercases emails and defaults the designation", async () => {
    const id = await createLead(w.ctx, w.amit, {
      client_name: "  Tidy Co  ",
      poc_email_id: "  Priya@Tidy.IN ",
      poc2_email_id: "X@Y.COM",
      poc_designation: "   ",
    });
    expect(await getLead(w.ctx, w.amit, id)).toMatchObject({
      client_name: "Tidy Co",
      client_name_normalized: "tidy co",
      poc_email_id: "priya@tidy.in",
      poc2_email_id: "x@y.com",
      poc_designation: "poc",
    });
  });

  it("keeps an explicit designation", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Director Co", poc_designation: "Director" });
    expect((await getLead(w.ctx, w.amit, id))?.poc_designation).toBe("Director");
  });

  it("rejects what the database would", async () => {
    await expect(createLead(w.ctx, w.amit, { client_name: "   " })).rejects.toThrow("Enter the client");
    await expect(createLead(w.ctx, w.amit, { client_name: "x".repeat(301) })).rejects.toThrow(/constraint/i);
    await expect(createLead(w.ctx, w.amit, { client_name: "Bad Mail", poc_email_id: "priya@" })).rejects.toThrow(/constraint/i);
    await expect(createLead(w.ctx, w.amit, { client_name: "Bad Phone", poc_contact_number: "9".repeat(33) })).rejects.toThrow(/constraint/i);
    await expect(createLead(w.ctx, w.amit, { client_name: "Bad Date", renewal_date: "2026-02-30" })).rejects.toThrow(/constraint/i);
  });

  it("only accepts visiting cards the agent uploaded", async () => {
    const own = `${w.amit.id}/0f6e6a3c-1b2d-4c5e-9f00-123456789abc.jpg`;
    const other = `${w.neha.id}/0f6e6a3c-1b2d-4c5e-9f00-123456789abc.jpg`;
    const id = await createLead(w.ctx, w.amit, { client_name: "Card Co", visiting_card_path: own });
    expect((await getLead(w.ctx, w.amit, id))?.visiting_card_path).toBe(own);
    await expect(createLead(w.ctx, w.amit, { client_name: "Card Co 2", visiting_card_path: other })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(createLead(w.ctx, w.amit, { client_name: "Card Co 3", visiting_card_path: "../../etc/passwd" })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("tracks when a lead was assigned", async () => {
    const unassigned = await createLead(w.ctx, w.admin, { client_name: "Pool Co" });
    expect((await getLead(w.ctx, w.admin, unassigned))?.assigned_at).toBeNull();
    await assignLead(w.ctx, w.admin, unassigned, w.neha.id);
    const lead = await getLead(w.ctx, w.neha, unassigned);
    expect(lead?.assigned_at).not.toBeNull();
    expect(lead?.agent_name).toBe("Neha Agent");
    await expect(assignLead(w.ctx, w.admin, unassigned, "not-a-member")).rejects.toThrow("active team member");
  });

  it("records every change in the audit log with who made it", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Audit Co" });
    await setLeadStatus(w.ctx, w.amit, id, "Follow-up");
    await setLeadStatus(w.ctx, w.amit, id, "Follow-up"); // no change, no row
    const rows = await sqlRows<{ action: string; actor_id: string; old_data: string; new_data: string }>(
      "select action, actor_id, old_data, new_data from audit_logs where table_name = 'leads' and record_id = ? order by id",
      String(id),
    );
    expect(rows.map((r) => r.action)).toEqual(["INSERT", "UPDATE"]);
    expect(rows.every((r) => r.actor_id === w.amit.id)).toBe(true);
    expect(JSON.parse(rows[1].old_data).status).toBe("Prospect");
    expect(JSON.parse(rows[1].new_data).status).toBe("Follow-up");
  });
});

describe("search and filters", () => {
  beforeAll(async () => {
    await createLead(w.ctx, w.amit, { client_name: "Search Kaveri Textiles", poc_contact_number: "+91 98450-12345", status: "Quoted" });
    await createLead(w.ctx, w.amit, { client_name: "Search 100% Pure", notes: "under_score" });
  });

  it("finds by name, phone digits and notes, case-insensitively", async () => {
    const names = async (q: string) => (await listLeads(w.ctx, w.amit, filters({ q }))).leads.map((l) => l.client_name);
    expect(await names("kaveri")).toEqual(["Search Kaveri Textiles"]);
    expect(await names("9845012345")).toContain("Search Kaveri Textiles");
    expect(await names("under_score")).toEqual(["Search 100% Pure"]);
    // "_" is literal, not a wildcard.
    expect(await names("under-score")).toEqual([]);
  });

  it("search input cannot widen the filter to other agents' leads", async () => {
    const names = (await listLeads(w.ctx, w.amit, filters({ q: "x%,client_name.ilike.%Neha%,(id.gt.0)" }))).leads;
    expect(names).toEqual([]);
    const all = (await listLeads(w.ctx, w.amit, filters({ q: "%" }))).leads.map((l) => l.client_name);
    expect(all).not.toContain("Neha Own Co");
  });

  it("counts by status within the caller's scope", async () => {
    const counts = await countLeadsByStatus(w.ctx, w.amit, filters({ q: "Search" }));
    expect(counts.Quoted).toBe(1);
    expect(counts.Prospect).toBe(1);
    const onlyQuoted = await countLeadsByStatus(w.ctx, w.amit, filters({ q: "Search", status: "Quoted" }));
    expect(onlyQuoted.Prospect).toBe(0);
  });

  it("sorts renewals with undated leads last", async () => {
    await createLead(w.ctx, w.neha, { client_name: "Sort B", renewal_date: "2030-02-01" });
    await createLead(w.ctx, w.neha, { client_name: "Sort A", renewal_date: "2030-01-01" });
    await createLead(w.ctx, w.neha, { client_name: "Sort C" });
    const order = (await listLeads(w.ctx, w.neha, filters({ q: "Sort", sort: "renewal_asc" }))).leads.map((l) => l.client_name);
    expect(order).toEqual(["Sort A", "Sort B", "Sort C"]);
  });
});

describe("duplicates", () => {
  it("scores names like pg_trgm", () => {
    expect([...trigrams("cat")].sort()).toEqual(["  c", " ca", "at ", "cat"]);
    expect(similarity("renee systems", "renee systems")).toBe(1);
    expect(nameScore("renee systems india", "renee systems")).toBeGreaterThan(0.6);
    expect(nameScore("zephyr logistics", "renee systems")).toBeLessThan(0.2);
  });

  it("flags an exact normalized match with the other owners' names", async () => {
    await createLead(w.ctx, w.amit, { client_name: "Renee Systems" });
    const dup = await createLead(w.ctx, w.neha, { client_name: "RENEE systems Pvt. Ltd." });
    expect(await getLead(w.ctx, w.neha, dup)).toMatchObject({
      is_duplicate: true,
      duplicate_label: "Duplicate: Already being processed by agent(s) [Amit Agent]",
    });
  });

  it("finds similar companies across agents, showing only the owner's name", async () => {
    const similar = await findSimilarLeads(w.ctx, w.neha, "Renee Systems India Pvt Ltd");
    expect(similar[0]).toMatchObject({ client_name: "Renee Systems", assigned_agent_name: "Amit Agent" });
    expect(Object.keys(similar[0]).sort()).toEqual(
      ["assigned_agent_id", "assigned_agent_name", "client_name", "is_exact", "lead_id", "similarity"].sort(),
    );
    expect(await findSimilarLeads(w.ctx, w.neha, "Zephyr Logistics")).toEqual([]);
    expect(await findSimilarLeads(w.ctx, w.neha, "   ")).toEqual([]);
  });

  it("puts exact matches first and can exclude the lead being edited", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Divya Co" });
    const found = await findSimilarLeads(w.ctx, w.neha, "Divya Co Pvt Ltd");
    expect(found[0]).toMatchObject({ lead_id: id, is_exact: true });
    expect(await findSimilarLeads(w.ctx, w.amit, "Divya Co", { excludeId: id })).toEqual([]);
  });

  it("follows the lifecycle: flag, resolve, respell, rename into a duplicate", async () => {
    await createLead(w.ctx, w.amit, { client_name: "Lifecycle Ltd" });
    const dup = await createLead(w.ctx, w.neha, { client_name: "Lifecycle" });
    expect((await getLead(w.ctx, w.admin, dup))?.is_duplicate).toBe(true);

    await resolveDuplicate(w.ctx, w.admin, dup);
    let lead = await getLead(w.ctx, w.admin, dup);
    expect(lead).toMatchObject({ is_duplicate: false, duplicate_label: "", duplicate_resolved_by: w.admin.id });

    // Same normalized name, different spelling: stays resolved.
    await updateLead(w.ctx, w.neha, dup, { client_name: "LIFECYCLE" });
    lead = await getLead(w.ctx, w.admin, dup);
    expect(lead).toMatchObject({ is_duplicate: false });
    expect(lead?.duplicate_resolved_at).not.toBeNull();

    await updateLead(w.ctx, w.neha, dup, { client_name: "Lifecycle Two" });
    expect((await getLead(w.ctx, w.admin, dup))?.duplicate_resolved_at).toBeNull();
    await updateLead(w.ctx, w.neha, dup, { client_name: "Lifecycle Pvt Ltd" });
    expect((await getLead(w.ctx, w.admin, dup))?.is_duplicate).toBe(true);
  });
});

describe("renewal milestones", () => {
  it("a renewal date creates the due event at 10:00 IST and nine reminders", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Renewal Co", renewal_date: "2030-03-15", policy_product: "Fire or Property" });
    const rows = await sqlRows<{ milestone: string; event_timestamp: string; is_background_reminder: number; title: string; assigned_agent_id: string }>(
      "select milestone, event_timestamp, is_background_reminder, title, assigned_agent_id from events where lead_id = ? and is_system_generated = 1 order by event_timestamp",
      id,
    );
    expect(rows).toHaveLength(10);
    const due = rows.find((r) => r.milestone === "DUE")!;
    expect(due.event_timestamp).toBe("2030-03-15T04:30:00.000Z");
    expect(due.is_background_reminder).toBe(0);
    expect(due.title).toBe("Renewal due: Renewal Co (Fire or Property)");
    expect(rows.find((r) => r.milestone === "T-5 Minutes")!.event_timestamp).toBe("2030-03-15T04:25:00.000Z");
    expect(rows.every((r) => r.assigned_agent_id === w.amit.id)).toBe(true);
    // The calendar only shows the due event.
    const visible = await getLeadEvents(w.ctx, w.amit, id);
    expect(visible.filter((e) => !e.is_background_reminder).map((e) => e.milestone)).toEqual(["DUE"]);
  });

  it("moving the date regenerates milestones and skips past ones; clearing it removes them", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Moving Co", renewal_date: "2030-03-15" });
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await updateLead(w.ctx, w.amit, id, { renewal_date: soon });
    const milestones = (await sqlRows<{ milestone: string }>("select milestone from events where lead_id = ? and is_system_generated = 1", id)).map(
      (r) => r.milestone,
    );
    expect(milestones).toContain("DUE");
    expect(milestones).not.toContain("T-30 Days");
    expect(milestones).not.toContain("T-3 Days");
    await updateLead(w.ctx, w.amit, id, { renewal_date: null });
    expect(await sqlRows("select id from events where lead_id = ?", id)).toEqual([]);
  });

  it("reassigning moves the reminders; renaming retitles them", async () => {
    const id = await createLead(w.ctx, w.admin, { client_name: "Handover Co", renewal_date: "2030-05-01", assigned_agent_id: w.amit.id });
    await assignLead(w.ctx, w.admin, id, w.neha.id);
    await updateLead(w.ctx, w.admin, id, { client_name: "Handover Two", policy_product: "Motor" });
    const rows = await sqlRows<{ assigned_agent_id: string; title: string; milestone: string }>(
      "select assigned_agent_id, title, milestone from events where lead_id = ? and is_system_generated = 1",
      id,
    );
    expect(new Set(rows.map((r) => r.assigned_agent_id))).toEqual(new Set([w.neha.id]));
    expect(rows.find((r) => r.milestone === "DUE")!.title).toBe("Renewal due: Handover Two (Motor)");
    expect(rows.find((r) => r.milestone === "T-1 Hour")!.title).toBe("T-1 Hour renewal reminder: Handover Two (Motor)");
    // The previous owner no longer sees them.
    expect(await listEvents(w.ctx, w.amit, { from: "2030-04-01T00:00:00Z", to: "2030-06-01T00:00:00Z" })).toEqual([]);
  });

  it("a maximum-length client name still gets every reminder, titles cut to 300", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "N".repeat(300), renewal_date: "2030-07-01" });
    const rows = await sqlRows<{ title: string }>("select title from events where lead_id = ?", id);
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.title.length <= 300)).toBe(true);
  });
});

describe("contacts", () => {
  it("fills POC 1, then POC 2, then notes, never overwriting and never repeating", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Contacts Co", poc_name: "Contact Person" });
    expect(await addLeadContact(w.ctx, w.amit, id, { name: "Priya", designation: "CFO", phone: "98450 11111" })).toBe("poc1");
    expect(await addLeadContact(w.ctx, w.amit, id, { name: "Ravi", phone: "98450 22222" })).toBe("poc2");
    expect(await addLeadContact(w.ctx, w.amit, id, { name: "PRIYA" })).toBe("existing");
    expect(await addLeadContact(w.ctx, w.amit, id, { name: "Someone", phone: "+91-98450-11111" })).toBe("existing");
    expect(await addLeadContact(w.ctx, w.amit, id, { name: "Sunil", phone: "98450 33333", email: "SUNIL@X.IN" })).toBe("notes");
    await expect(addLeadContact(w.ctx, w.amit, id, {})).rejects.toThrow("needs a name, phone or email");

    const lead = (await getLead(w.ctx, w.amit, id))!;
    expect(lead).toMatchObject({
      poc_name: "Priya",
      poc_designation: "CFO",
      poc2_name: "Ravi",
      poc2_designation: "poc",
      notes: "[Additional Contact: Sunil (poc) - 98450 33333, sunil@x.in]",
    });
  });
});

describe("notes", () => {
  let lead: number;

  beforeAll(async () => {
    lead = await createLead(w.ctx, w.admin, { client_name: "Notes Co", assigned_agent_id: w.amit.id });
  });

  it("are signed by the server and trimmed; blank and huge notes are refused", async () => {
    const note = await addLeadNote(w.ctx, w.amit, lead, "  Quote sent  ");
    expect(note).toMatchObject({ content: "Quote sent", agent_name: "Amit Agent", agent_id: w.amit.id });
    await expect(addLeadNote(w.ctx, w.amit, lead, "   ")).rejects.toThrow("Write a note first.");
    await expect(addLeadNote(w.ctx, w.amit, lead, "x".repeat(5001))).rejects.toThrow("under 5000");
  });

  it("teammates' notes are unread until read; your own never are", async () => {
    await addLeadNote(w.ctx, w.admin, lead, "Call them Monday");
    expect(await countUnreadLeadNotes(w.ctx, w.amit)).toBe(1);
    const feed = await unreadLeadNotes(w.ctx, w.amit);
    expect(feed[0]).toMatchObject({ client_name: "Notes Co", content: "Call them Monday", agent_name: "Asha Admin" });
    // Neha cannot see this lead, so nothing is unread for her.
    expect(await countUnreadLeadNotes(w.ctx, w.neha)).toBe(0);
    expect(await markLeadNotesRead(w.ctx, w.neha, lead)).toBe(0);

    expect(await markLeadNotesRead(w.ctx, w.amit, lead)).toBe(1);
    expect(await countUnreadLeadNotes(w.ctx, w.amit)).toBe(0);
    expect(await markLeadNotesRead(w.ctx, w.amit)).toBe(0);
  });

  it("only admins delete notes, and the deletion is audited", async () => {
    const note = await addLeadNote(w.ctx, w.amit, lead, "to delete");
    await expect(deleteLeadNote(w.ctx, w.amit, note.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await deleteLeadNote(w.ctx, w.admin, note.id);
    expect((await getLeadNotes(w.ctx, w.amit, lead)).map((n) => n.content)).not.toContain("to delete");
    expect(await sqlRows("select id from audit_logs where table_name = 'lead_notes' and record_id = ?", String(note.id))).toHaveLength(1);
  });
});

describe("tasks", () => {
  it("agents plan for themselves; admins assign to active members", async () => {
    const at = "2030-01-10T04:30:00.000Z";
    const own = await createTask(w.ctx, w.amit, { title: " Call Priya ", event_timestamp: at });
    expect(own).toMatchObject({ title: "Call Priya", assigned_agent_id: w.amit.id, created_by: w.amit.id, is_system_generated: false });
    await expect(createTask(w.ctx, w.amit, { title: "For Neha", event_timestamp: at, assigned_agent_id: w.neha.id })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    const assigned = await createTask(w.ctx, w.admin, { title: "For Neha", event_timestamp: at, assigned_agent_id: w.neha.id });
    expect(assigned.assigned_agent_id).toBe(w.neha.id);
    await expect(createTask(w.ctx, w.amit, { title: "  ", event_timestamp: at })).rejects.toThrow("Describe the task.");
  });

  it("can be completed and deleted by their owner only; milestones only completed", async () => {
    const task = await createTask(w.ctx, w.neha, { title: "Visit", event_timestamp: "2030-01-11T04:30:00.000Z" });
    await expect(setEventDone(w.ctx, w.amit, task.id, true)).rejects.toBeInstanceOf(InvalidInputError);
    await setEventDone(w.ctx, w.neha, task.id, true);
    expect((await sqlRows<{ completed_at: string }>("select completed_at from events where id = ?", task.id))[0].completed_at).not.toBeNull();
    await setEventDone(w.ctx, w.neha, task.id, false);
    expect((await sqlRows<{ completed_at: string }>("select completed_at from events where id = ?", task.id))[0].completed_at).toBeNull();
    await expect(deleteTask(w.ctx, w.amit, task.id)).rejects.toBeInstanceOf(InvalidInputError);
    await deleteTask(w.ctx, w.neha, task.id);

    const lead = await createLead(w.ctx, w.neha, { client_name: "Milestone Owner Co", renewal_date: "2030-09-09" });
    const [due] = await sqlRows<{ id: number }>("select id from events where lead_id = ? and milestone = 'DUE'", lead);
    await setEventDone(w.ctx, w.neha, due.id, true);
    await expect(deleteTask(w.ctx, w.neha, due.id)).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe("renewal reminders", () => {
  it("notify the agent once for the latest due milestone; unassigned leads notify admins; closed leads stay quiet", async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000);
    const date = soon.toISOString().slice(0, 10);
    const assigned = await createLead(w.ctx, w.admin, {
      client_name: "Remind Co",
      renewal_date: date,
      assigned_agent_id: w.amit.id,
      poc_name: "Sunil",
      poc_contact_number: "9845011111",
    });
    const unassigned = await createLead(w.ctx, w.admin, { client_name: "Orphan Co", renewal_date: date });
    const closed = await createLead(w.ctx, w.admin, { client_name: "Closed Renewal Co", renewal_date: date, assigned_agent_id: w.amit.id, status: "Closed Won" });

    // Pretend it is just after the renewal is due: everything is due.
    const later = new Date(Date.parse(`${date}T05:00:00Z`));
    await deliverDueReminders(w.ctx, later);

    const amitBell = await recentNotifications(w.ctx, w.amit);
    const remind = amitBell.items.filter((n) => n.lead_id === assigned);
    expect(remind).toHaveLength(1);
    expect(remind[0].title).toBe("T-5 Minutes: Remind Co renewal (Health)");
    expect(remind[0].body).toContain("Contact: Sunil (9845011111)");
    expect(amitBell.items.some((n) => n.lead_id === closed)).toBe(false);

    const adminBell = await recentNotifications(w.ctx, w.admin);
    const orphan = adminBell.items.filter((n) => n.lead_id === unassigned);
    expect(orphan).toHaveLength(1);
    expect(orphan[0].body).toContain("This lead is unassigned.");
    expect((await recentNotifications(w.ctx, w.neha)).items.some((n) => n.lead_id === assigned)).toBe(false);

    // Everything due was marked sent, including the closed lead's; a second run sends nothing.
    expect(await sqlRows("select id from events where is_background_reminder = 1 and reminder_sent_at is null and lead_id in (?, ?, ?)", assigned, unassigned, closed)).toEqual([]);
    expect(await deliverDueReminders(w.ctx, later)).toBe(0);
  });

  it("future reminders stay pending", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Future Co", renewal_date: "2031-06-01" });
    await deliverDueReminders(w.ctx);
    expect(await sqlRows("select id from events where lead_id = ? and reminder_sent_at is not null", id)).toEqual([]);
  });

  it("a deactivated agent's reminders go to the admins", async () => {
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const id = await createLead(w.ctx, w.admin, { client_name: "Away Co", renewal_date: date, assigned_agent_id: w.neha.id });
    await setActive(w.ctx, w.admin, w.neha.id, false);
    try {
      await deliverDueReminders(w.ctx, new Date(Date.parse(`${date}T05:00:00Z`)));
      expect((await recentNotifications(w.ctx, w.admin)).items.some((n) => n.lead_id === id)).toBe(true);
    } finally {
      await setActive(w.ctx, w.admin, w.neha.id, true);
    }
  });

  it("users read and dismiss only their own", async () => {
    const before = await recentNotifications(w.ctx, w.amit);
    expect(before.unread).toBeGreaterThan(0);
    const [first] = before.items;
    await markNotificationsRead(w.ctx, w.neha, first.id);
    expect((await recentNotifications(w.ctx, w.amit)).unread).toBe(before.unread);
    await markNotificationsRead(w.ctx, w.amit, first.id);
    expect((await recentNotifications(w.ctx, w.amit)).unread).toBe(before.unread - 1);
    await markNotificationsRead(w.ctx, w.amit);
    expect((await recentNotifications(w.ctx, w.amit)).unread).toBe(0);
  });
});
