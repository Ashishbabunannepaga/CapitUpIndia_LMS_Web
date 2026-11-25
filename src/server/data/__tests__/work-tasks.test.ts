import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { addDays, todayInBusinessTz } from "@/lib/dates";
import { normalizeTag, parseTags, suggestDueFromRenewal, tagsFromLead, waitingOn } from "@/lib/work-tasks";

import { auditLogs, notifications, workTaskMessages, workTasks } from "../../db/schema";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { createLead } from "../leads";
import {
  createWorkTask,
  deleteWorkTask,
  getTaskThread,
  leadTaskContext,
  listTasks,
  markTaskRead,
  nudgeWorkTask,
  pinnedTasks,
  postTaskMessage,
  setWorkTaskStatus,
  taskTags,
  updateWorkTask,
} from "../work-tasks";
import { testWorld } from "./helpers";

// Task Grid: who can see, give, change and talk on tasks.

let w: Awaited<ReturnType<typeof testWorld>>;
const today = todayInBusinessTz();

beforeAll(async () => {
  w = await testWorld();
});
afterAll(async () => {
  await w.dispose();
});

const bell = (userId: string, taskId: number) =>
  w.ctx.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.user_id, userId), eq(notifications.task_id, taskId)));

describe("creating and seeing tasks", () => {
  it("keeps an agent's personal task to themselves, even from admins", async () => {
    const task = await createWorkTask(w.ctx, w.amit, {
      title: "Call back Rajesh",
      priority: "P3",
    });
    expect(task).toMatchObject({
      kind: "personal",
      assignee_id: w.amit.id,
      created_by: w.amit.id,
      status: "todo",
    });
    expect((await listTasks(w.ctx, w.amit)).map((t) => t.id)).toContain(task.id);
    expect((await listTasks(w.ctx, w.neha)).map((t) => t.id)).not.toContain(task.id);
    expect((await listTasks(w.ctx, w.admin)).map((t) => t.id)).not.toContain(task.id);
    expect(await getTaskThread(w.ctx, w.admin, task.id)).toBeNull();
    await expect(postTaskMessage(w.ctx, w.neha, task.id, { body: "hi" })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("lets only admins give tasks to someone else", async () => {
    await expect(
      createWorkTask(w.ctx, w.amit, {
        title: "Do my work",
        assignee_id: w.neha.id,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const task = await createWorkTask(w.ctx, w.admin, {
      title: "Collect KYC for Acme",
      priority: "P1",
      assignee_id: w.amit.id,
      due_at: new Date(Date.now() + 86_400_000).toISOString(),
      tags: "KYC, docs pending, kyc",
    });
    expect(task).toMatchObject({
      kind: "assigned",
      assignee_id: w.amit.id,
      created_by: w.admin.id,
      created_by_name: "Asha Admin",
    });
    // Assignee, giver and admins see it; other agents do not.
    expect((await listTasks(w.ctx, w.amit)).map((t) => t.id)).toContain(task.id);
    expect((await listTasks(w.ctx, w.neha)).map((t) => t.id)).not.toContain(task.id);
    const thread = await getTaskThread(w.ctx, w.amit, task.id);
    expect(thread?.task.tags).toEqual(["docs pending", "kyc"]);
    expect(thread?.messages[0]).toMatchObject({ kind: "system" });
    // The assignee hears about it, and the audit log records it.
    expect(await bell(w.amit.id, task.id)).toHaveLength(1);
    const audit = await w.ctx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.table_name, "work_tasks"), eq(auditLogs.record_id, String(task.id))));
    expect(audit[0]).toMatchObject({ action: "INSERT", actor_id: w.admin.id });
  });

  it("rejects inactive assignees, bad priorities and empty titles", async () => {
    await expect(createWorkTask(w.ctx, w.admin, { title: "  " })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(createWorkTask(w.ctx, w.admin, { title: "x", priority: "P9" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(createWorkTask(w.ctx, w.admin, { title: "x", assignee_id: "nobody" })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("links only leads the creator can see and tags from the lead", async () => {
    const leadId = await createLead(w.ctx, w.neha, {
      client_name: "Tagline Foods Pvt Ltd",
      policy_product: "Health",
      business_type: "Corporate",
      type: "Renewal",
      renewal_date: addDays(today, 45),
    });
    await expect(createWorkTask(w.ctx, w.amit, { title: "Peek", lead_id: leadId })).rejects.toBeInstanceOf(InvalidInputError);
    const task = await createWorkTask(w.ctx, w.neha, {
      title: "Re-quote GMC",
      lead_id: leadId,
    });
    const thread = await getTaskThread(w.ctx, w.neha, task.id);
    expect(thread?.task.lead_name).toBe("Tagline Foods Pvt Ltd");
    expect(thread?.task.tags).toEqual(["corporate", "health", "renewal"]);
    const ctx = await leadTaskContext(w.ctx, w.neha, leadId);
    expect(ctx?.renewal_date).toBe(addDays(today, 45));
    expect((await listTasks(w.ctx, w.neha, { lead: leadId })).map((t) => t.id)).toEqual([task.id]);
    expect(await taskTags(w.ctx, w.neha)).toContain("health");
  });
});

describe("the task thread", () => {
  it("lets assignee and giver talk, counts unread, and marks it seen", async () => {
    const task = await createWorkTask(w.ctx, w.admin, {
      title: "Send renewal quote",
      assignee_id: w.neha.id,
    });
    await postTaskMessage(w.ctx, w.neha, task.id, {
      body: "Which insurer should I quote first?",
      via: "voice",
    });
    await postTaskMessage(w.ctx, w.neha, task.id, {
      body: "Also need the claims data.",
    });

    const [forAdmin] = (await listTasks(w.ctx, w.admin)).filter((t) => t.id === task.id);
    expect(forAdmin.unread).toBe(2);
    expect(forAdmin.last_message?.author_id).toBe(w.neha.id);
    expect(waitingOn(forAdmin, forAdmin.last_message?.author_id ?? null)).toBe("giver");
    // One bell item for the admin until read, not one per message.
    expect(await bell(w.admin.id, task.id)).toHaveLength(1);

    const pinned = await pinnedTasks(w.ctx, w.admin);
    expect(pinned.find((p) => p.id === task.id)).toMatchObject({
      role: "given",
      unread: 2,
    });

    await markTaskRead(w.ctx, w.admin, task.id);
    expect((await listTasks(w.ctx, w.admin)).find((t) => t.id === task.id)?.unread).toBe(0);
    expect((await bell(w.admin.id, task.id)).every((n) => n.read_at)).toBe(true);

    await postTaskMessage(w.ctx, w.admin, task.id, {
      body: "ICICI first. Claims data is on the lead.",
    });
    const neha = await pinnedTasks(w.ctx, w.neha);
    const pin = neha.find((p) => p.id === task.id);
    expect(pin).toMatchObject({ role: "incoming", unread: 1 });
    expect(pin?.recent.at(-1)?.body).toBe("ICICI first. Claims data is on the lead.");
    expect(pin?.recent.length).toBeLessThanOrEqual(3);

    await markTaskRead(w.ctx, w.neha, task.id);
    const [row] = await w.ctx.db.select().from(workTasks).where(eq(workTasks.id, task.id));
    expect(row.seen_at).not.toBeNull();
  });

  it("refuses empty or oversized messages", async () => {
    const task = await createWorkTask(w.ctx, w.amit, {
      title: "Notes to self",
    });
    await expect(postTaskMessage(w.ctx, w.amit, task.id, { body: "   " })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(postTaskMessage(w.ctx, w.amit, task.id, { body: "x".repeat(4001) })).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("changing tasks", () => {
  it("lets the assignee move status but not edit, and tells the giver when blocked or done", async () => {
    const task = await createWorkTask(w.ctx, w.admin, {
      title: "Chase policy copy",
      assignee_id: w.amit.id,
    });
    await expect(updateWorkTask(w.ctx, w.amit, task.id, { title: "Something else" })).rejects.toBeInstanceOf(AccessDeniedError);
    await setWorkTaskStatus(w.ctx, w.amit, task.id, "in_progress");
    await setWorkTaskStatus(w.ctx, w.amit, task.id, "blocked", "Insurer portal is down");
    const thread = await getTaskThread(w.ctx, w.admin, task.id);
    expect(thread?.task.status).toBe("blocked");
    expect(thread?.messages.map((m) => m.body)).toContain("Insurer portal is down");
    expect((await bell(w.admin.id, task.id)).map((n) => n.title)).toContain("Amit Agent is blocked on: Chase policy copy");
    expect((await pinnedTasks(w.ctx, w.admin)).some((p) => p.id === task.id)).toBe(true);

    await setWorkTaskStatus(w.ctx, w.amit, task.id, "done");
    const [row] = await w.ctx.db.select().from(workTasks).where(eq(workTasks.id, task.id));
    expect(row.completed_at).not.toBeNull();
    expect((await pinnedTasks(w.ctx, w.amit)).some((p) => p.id === task.id)).toBe(false);
    await expect(setWorkTaskStatus(w.ctx, w.neha, task.id, "todo")).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("lets admins edit, retag and hand a task to someone else", async () => {
    const task = await createWorkTask(w.ctx, w.admin, {
      title: "Visit client",
      assignee_id: w.amit.id,
      tags: ["field"],
    });
    await updateWorkTask(w.ctx, w.admin, task.id, {
      priority: "P1",
      tags: "field, urgent",
      assignee_id: w.neha.id,
    });
    const thread = await getTaskThread(w.ctx, w.neha, task.id);
    expect(thread?.task).toMatchObject({
      priority: "P1",
      assignee_id: w.neha.id,
      tags: ["field", "urgent"],
    });
    expect(await getTaskThread(w.ctx, w.amit, task.id)).toBeNull();
    expect(await bell(w.neha.id, task.id)).toHaveLength(1);
    // Agents cannot hand their own tasks on.
    const mine = await createWorkTask(w.ctx, w.amit, { title: "Mine" });
    await expect(updateWorkTask(w.ctx, w.amit, mine.id, { assignee_id: w.neha.id })).rejects.toBeInstanceOf(AccessDeniedError);
    await updateWorkTask(w.ctx, w.amit, mine.id, {
      title: "Mine, renamed",
      due_at: null,
    });
  });

  it("rate-limits nudges and only lets the giver's side nudge", async () => {
    const task = await createWorkTask(w.ctx, w.admin, {
      title: "Update CRM",
      assignee_id: w.amit.id,
    });
    await expect(nudgeWorkTask(w.ctx, w.amit, task.id)).rejects.toBeInstanceOf(AccessDeniedError);
    const now = new Date();
    await nudgeWorkTask(w.ctx, w.admin, task.id, now);
    await expect(nudgeWorkTask(w.ctx, w.admin, task.id, new Date(now.getTime() + 60_000))).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await nudgeWorkTask(w.ctx, w.admin, task.id, new Date(now.getTime() + 31 * 60_000));
    const lines = await w.ctx.db.select().from(workTaskMessages).where(eq(workTaskMessages.task_id, task.id));
    expect(lines.filter((l) => l.body.includes("nudge"))).toHaveLength(2);
  });

  it("lets only the giver or an admin delete, and cascades the thread", async () => {
    const task = await createWorkTask(w.ctx, w.admin, {
      title: "Temp",
      assignee_id: w.amit.id,
    });
    await postTaskMessage(w.ctx, w.amit, task.id, { body: "ok" });
    await expect(deleteWorkTask(w.ctx, w.amit, task.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await deleteWorkTask(w.ctx, w.admin, task.id);
    expect(await w.ctx.db.select().from(workTaskMessages).where(eq(workTaskMessages.task_id, task.id))).toHaveLength(0);
    expect(await bell(w.amit.id, task.id)).toHaveLength(0);
  });
});

describe("filters", () => {
  it("filters by view, status, priority, assignee, tag and due", async () => {
    const overdue = await createWorkTask(w.ctx, w.admin, {
      title: "Overdue thing",
      assignee_id: w.neha.id,
      priority: "P3",
      due_at: new Date(Date.now() - 3_600_000).toISOString(),
      tags: "late",
    });
    const given = await listTasks(w.ctx, w.admin, { view: "given" });
    expect(given.every((t) => t.created_by === w.admin.id && t.assignee_id !== w.admin.id)).toBe(true);
    expect((await listTasks(w.ctx, w.admin, { due: "overdue" })).map((t) => t.id)).toContain(overdue.id);
    expect(
      (
        await listTasks(w.ctx, w.admin, {
          priority: "P3",
          assignee: w.neha.id,
          tag: "late",
        })
      ).map((t) => t.id),
    ).toEqual([overdue.id]);
    expect((await listTasks(w.ctx, w.admin, { status: "done" })).some((t) => t.id === overdue.id)).toBe(false);
    expect(
      (
        await listTasks(w.ctx, w.neha, {
          view: "mine",
          status: "open",
          q: "overdue",
        })
      ).map((t) => t.id),
    ).toEqual([overdue.id]);
    // An agent filtering by someone else's id still only gets their own visible tasks.
    expect(await listTasks(w.ctx, w.amit, { assignee: w.neha.id })).toEqual([]);
  });
});

describe("task helpers", () => {
  it("normalises tags", () => {
    expect(normalizeTag("  Docs   Pending!! ")).toBe("docs pending");
    expect(parseTags("a, A, b,, c, d, e, f, g")).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("suggests a due date from the renewal date", () => {
    const t = "2026-11-25";
    expect(suggestDueFromRenewal("2027-01-30", t)?.date).toBe("2026-12-31");
    expect(suggestDueFromRenewal("2026-12-15", t)?.date).toBe("2026-12-05");
    expect(suggestDueFromRenewal("2026-11-30", t)?.date).toBe("2026-11-26");
    expect(suggestDueFromRenewal("2026-11-25", t)?.date).toBe("2026-11-25");
    expect(suggestDueFromRenewal("2026-11-20", t)).toBeNull();
    expect(suggestDueFromRenewal(null, t)).toBeNull();
  });

  it("tags from lead context", () => {
    expect(
      tagsFromLead({
        policy_product: "Fire or Property",
        business_type: "Retail",
        type: "New",
        status: "Quoted",
        renewal_date: null,
      }),
    ).toEqual(["fire", "retail", "quote"]);
  });
});
