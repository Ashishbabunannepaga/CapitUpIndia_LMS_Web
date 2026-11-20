import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AccessDeniedError, InvalidInputError } from "../errors";
import { createTask } from "../events";
import { createLead, getLead } from "../leads";
import { recentNotifications } from "../notifications";
import { createUser, deactivateUser, offboardingSummary, setActive } from "../users";
import { PASSWORD, testWorld } from "./helpers";

// R4 (enterprise audit): disabling an agent must not strand their leads,
// renewal reminders and tasks with someone who can no longer sign in.

let w: Awaited<ReturnType<typeof testWorld>>;
const sqlRows = async <T>(query: string, ...binds: unknown[]) => (await w.d1.prepare(query).bind(...binds).all<T>()).results;
let n = 0;
const newAgent = async () => createUser(w.ctx, w.admin, { email: `leaver${++n}@capitup.test`, fullName: `Leaver ${n}`, password: PASSWORD });

beforeAll(async () => {
  w = await testWorld();
}, 60_000);
afterAll(async () => {
  await w?.dispose();
});

describe("disabling an agent", () => {
  it("refuses a plain disable while they hold leads or open tasks", async () => {
    const leaver = await newAgent();
    await createLead(w.ctx, w.admin, { client_name: "Held Lead Co", assigned_agent_id: leaver.id });
    expect(await offboardingSummary(w.ctx, w.admin, leaver.id)).toEqual({ leads: 1, tasks: 0 });
    await expect(setActive(w.ctx, w.admin, leaver.id, false)).rejects.toBeInstanceOf(InvalidInputError);
    expect((await sqlRows<{ is_active: number }>("select is_active from profiles where id = ?", leaver.id))[0].is_active).toBe(1);
  });

  it("hands every lead, its renewal reminders and open tasks to the chosen agent", async () => {
    const leaver = await newAgent();
    const a = await createLead(w.ctx, w.admin, { client_name: "Handover One", assigned_agent_id: leaver.id, renewal_date: "2031-02-01" });
    const b = await createLead(w.ctx, w.admin, { client_name: "Handover Two", assigned_agent_id: leaver.id, status: "Closed Won" });
    const open = await createTask(w.ctx, w.admin, { title: "Open call", assigned_agent_id: leaver.id, event_timestamp: "2031-01-05T05:00:00Z" });
    const done = await createTask(w.ctx, w.admin, { title: "Done call", assigned_agent_id: leaver.id, event_timestamp: "2030-01-05T05:00:00Z" });
    await w.d1.prepare("update events set is_completed = 1 where id = ?").bind(done.id).run();

    expect(await offboardingSummary(w.ctx, w.admin, leaver.id)).toEqual({ leads: 2, tasks: 1 });
    expect(await deactivateUser(w.ctx, w.admin, leaver.id, { to: w.amit.id })).toEqual({ leads: 2, tasks: 1 });

    expect((await getLead(w.ctx, w.admin, a))!.assigned_agent_id).toBe(w.amit.id);
    expect((await getLead(w.ctx, w.admin, b))!.assigned_agent_id).toBe(w.amit.id);
    // Renewal milestones follow the lead.
    expect(await sqlRows("select id from events where lead_id = ? and assigned_agent_id is not ?", a, w.amit.id)).toEqual([]);
    // The open task moves; the finished one stays as history.
    expect((await sqlRows<{ assigned_agent_id: string }>("select assigned_agent_id from events where id = ?", open.id))[0].assigned_agent_id).toBe(w.amit.id);
    expect((await sqlRows<{ assigned_agent_id: string }>("select assigned_agent_id from events where id = ?", done.id))[0].assigned_agent_id).toBe(leaver.id);
    // Disabled, with an audit row per lead and one message to Amit.
    expect((await sqlRows<{ is_active: number }>("select is_active from profiles where id = ?", leaver.id))[0].is_active).toBe(0);
    expect(await sqlRows("select id from audit_logs where table_name = 'leads' and record_id in (?, ?) and action = 'UPDATE'", String(a), String(b))).toHaveLength(2);
    const bell = (await recentNotifications(w.ctx, w.amit)).items;
    expect(bell.some((x) => x.title === "2 leads and 1 open task handed over to you")).toBe(true);
  });

  it("can put the leads in the Unassigned pool; open tasks then go to the admin", async () => {
    const leaver = await newAgent();
    const id = await createLead(w.ctx, w.admin, { client_name: "To The Pool", assigned_agent_id: leaver.id });
    const task = await createTask(w.ctx, w.admin, { title: "Pool task", assigned_agent_id: leaver.id, event_timestamp: "2031-01-06T05:00:00Z" });
    await deactivateUser(w.ctx, w.admin, leaver.id, { to: null });
    expect((await getLead(w.ctx, w.admin, id))!.assigned_agent_id).toBeNull();
    expect((await sqlRows<{ assigned_agent_id: string }>("select assigned_agent_id from events where id = ?", task.id))[0].assigned_agent_id).toBe(w.admin.id);
  });

  it("lets an admin skip the handover on purpose", async () => {
    const leaver = await newAgent();
    const id = await createLead(w.ctx, w.admin, { client_name: "Kept With Leaver", assigned_agent_id: leaver.id });
    expect(await deactivateUser(w.ctx, w.admin, leaver.id, "skip")).toEqual({ leads: 0, tasks: 0 });
    expect((await getLead(w.ctx, w.admin, id))!.assigned_agent_id).toBe(leaver.id);
    expect((await sqlRows<{ is_active: number }>("select is_active from profiles where id = ?", leaver.id))[0].is_active).toBe(0);
  });

  it("refuses handing over to the leaver, an inactive person, or as an agent", async () => {
    const leaver = await newAgent();
    const gone = await newAgent();
    await deactivateUser(w.ctx, w.admin, gone.id, "skip");
    await createLead(w.ctx, w.admin, { client_name: "Refusals Ltd", assigned_agent_id: leaver.id });
    await expect(deactivateUser(w.ctx, w.admin, leaver.id, { to: leaver.id })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(deactivateUser(w.ctx, w.admin, leaver.id, { to: gone.id })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(deactivateUser(w.ctx, w.amit, leaver.id, { to: w.amit.id })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(offboardingSummary(w.ctx, w.amit, leaver.id)).rejects.toBeInstanceOf(AccessDeniedError);
    // Nothing moved and they are still active.
    expect((await sqlRows<{ is_active: number }>("select is_active from profiles where id = ?", leaver.id))[0].is_active).toBe(1);
  });

  it("never disables the last active admin, before moving anything", async () => {
    await expect(deactivateUser(w.ctx, w.admin, w.admin.id, { to: w.amit.id })).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
