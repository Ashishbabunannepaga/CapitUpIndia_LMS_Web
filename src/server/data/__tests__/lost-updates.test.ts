import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ConflictError } from "../errors";
import { assignLead, createLead, getLead, getLeadPage, setLeadStatus, updateLead } from "../leads";
import { testWorld } from "./helpers";

// R1 (enterprise audit): two people saving the same lead must never silently
// undo each other. A form carries the version it was opened with; every
// write is guarded by the version it read.

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
});
afterAll(async () => {
  await w?.dispose();
});

describe("concurrent lead edits", () => {
  it("rejects an edit form opened before an admin reassigned the lead, and keeps the reassignment", async () => {
    const id = await createLead(w.ctx, w.admin, { client_name: "Race Industries", assigned_agent_id: w.amit.id });
    const opened = (await getLead(w.ctx, w.admin, id))!;

    // The admin moves the lead to Neha while the form is open.
    await assignLead(w.ctx, w.admin, id, w.neha.id);

    // The admin's own stale form (it still says Amit) is refused.
    await expect(
      updateLead(
        w.ctx,
        w.admin,
        id,
        { client_name: "Race Industries", notes: "typed while open", assigned_agent_id: w.amit.id },
        { expectedUpdatedAt: opened.updated_at },
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const after = (await getLead(w.ctx, w.admin, id))!;
    expect(after.assigned_agent_id).toBe(w.neha.id);
    expect(after.notes).toBe("");
  });

  it("rejects a stale form after a status change and says to reload", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Stale Form Pvt Ltd" });
    const opened = (await getLead(w.ctx, w.amit, id))!;
    await setLeadStatus(w.ctx, w.admin, id, "Quoted");
    const error = await updateLead(w.ctx, w.amit, id, { status: "Prospect", notes: "x" }, { expectedUpdatedAt: opened.updated_at }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(String(error.message)).toMatch(/Reload and try again/);
    expect((await getLead(w.ctx, w.amit, id))!.status).toBe("Quoted");
  });

  it("saves a form whose version is current", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Current Version Ltd" });
    const opened = (await getLead(w.ctx, w.amit, id))!;
    await updateLead(w.ctx, w.amit, id, { notes: "fine" }, { expectedUpdatedAt: opened.updated_at });
    const after = (await getLead(w.ctx, w.amit, id))!;
    expect(after.notes).toBe("fine");
    expect(after.updated_at).not.toBe(opened.updated_at);
  });

  it("never loses either change when a status change and a reassignment race", async () => {
    const id = await createLead(w.ctx, w.admin, { client_name: "Parallel Saves Ltd", assigned_agent_id: w.amit.id });
    const results = await Promise.allSettled([
      setLeadStatus(w.ctx, w.amit, id, "Follow-up"),
      assignLead(w.ctx, w.admin, id, w.neha.id),
    ]);
    const after = (await getLead(w.ctx, w.admin, id))!;
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ConflictError);
    }
    // Whatever succeeded is in the row; whatever failed said so.
    if (results[0].status === "fulfilled") expect(after.status).toBe("Follow-up");
    if (results[1].status === "fulfilled") expect(after.assigned_agent_id).toBe(w.neha.id);
  });

  it("aborts the whole batch on a conflict: no audit row, no milestones for the refused date", async () => {
    const id = await createLead(w.ctx, w.admin, { client_name: "Atomic Ltd", assigned_agent_id: w.amit.id });
    const opened = (await getLead(w.ctx, w.admin, id))!;
    await assignLead(w.ctx, w.admin, id, w.neha.id);
    const before = (await getLeadPage(w.ctx, w.admin, id))!;
    await expect(
      updateLead(w.ctx, w.admin, id, { renewal_date: "2031-01-15" }, { expectedUpdatedAt: opened.updated_at }),
    ).rejects.toBeInstanceOf(ConflictError);
    const after = (await getLeadPage(w.ctx, w.admin, id))!;
    expect(after.events.length).toBe(before.events.length);
    expect(after.lead.renewal_date).toBeNull();
  });

  it("the in-batch guard refuses a write based on a stale read, even without a form version", async () => {
    const id = await createLead(w.ctx, w.admin, { client_name: "Guarded Ltd", assigned_agent_id: w.amit.id });
    const stale = (await w.ctx.db.query.leads.findFirst({ where: (l, { eq }) => eq(l.id, id) }))!;
    await assignLead(w.ctx, w.admin, id, w.neha.id);
    // The next read returns the copy from before the reassignment, as if the
    // two requests had interleaved.
    const spy = vi.spyOn(w.ctx.db.query.leads, "findFirst").mockResolvedValueOnce(stale);
    try {
      await expect(setLeadStatus(w.ctx, w.amit, id, "Quoted")).rejects.toBeInstanceOf(ConflictError);
    } finally {
      spy.mockRestore();
    }
    const after = (await getLead(w.ctx, w.admin, id))!;
    expect(after.assigned_agent_id).toBe(w.neha.id);
    expect(after.status).toBe("Prospect");
  });
});
