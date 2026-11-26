import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { notifications } from "../../db/schema";
import { AccessDeniedError, InvalidInputError } from "../errors";
import {
  createWorkTask,
  deleteTaskTemplate,
  deleteWorkTask,
  getTaskThread,
  listTasks,
  listTaskTemplates,
  pinnedTasks,
  postTaskMessage,
  saveTaskTemplate,
  setWorkTaskStatus,
  sniffAudio,
  storeTaskVoice,
  taskPermissions,
  taskRecipients,
  taskVoice,
  updateWorkTask,
} from "../work-tasks";
import { testWorld } from "./helpers";

// Task Grid additions: agents raising tasks to admins, recorded voice notes, templates.

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
});
afterAll(async () => {
  await w.dispose();
});

// A minimal WebM header (EBML magic) plus padding: enough for the type check.
const webm = () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(60).fill(0x42)]);

describe("raising a task to an admin", () => {
  it("lets an agent raise to an admin, but never to another agent", async () => {
    await expect(createWorkTask(w.ctx, w.amit, { title: "Do Neha's work", assignee_id: w.neha.id })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    const task = await createWorkTask(w.ctx, w.amit, { title: "Insurer rejected the GMC quote", priority: "P1", assignee_id: w.admin.id });
    expect(task).toMatchObject({ kind: "assigned", raised: true, assignee_id: w.admin.id, created_by: w.amit.id });

    // The admin hears about it and sees it pinned on My Day; other agents don't see it.
    const bell = await w.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.user_id, w.admin.id), eq(notifications.task_id, task.id)));
    expect(bell[0]?.title).toMatch(/raised a task/);
    const pinned = await pinnedTasks(w.ctx, w.admin);
    expect(pinned.find((p) => p.id === task.id)).toMatchObject({ role: "incoming", raised: true });
    expect((await listTasks(w.ctx, w.neha)).map((t) => t.id)).not.toContain(task.id);
    expect((await listTasks(w.ctx, w.admin, { view: "raised" })).map((t) => t.id)).toContain(task.id);

    // The thread says it was raised; both sides can move it.
    const thread = await getTaskThread(w.ctx, w.admin, task.id);
    expect(thread?.messages[0].body).toMatch(/raised this to/);
    await setWorkTaskStatus(w.ctx, w.admin, task.id, "in_progress");
    await setWorkTaskStatus(w.ctx, w.amit, task.id, "done");
  });

  it("lets an agent raise their own to-do later, and lists only admins as recipients", async () => {
    const todo = await createWorkTask(w.ctx, w.amit, { title: "Client wants a premium discount" });
    expect(todo.raised).toBe(false);
    expect(taskPermissions(w.amit, todo).reassign).toBe(true);
    await expect(updateWorkTask(w.ctx, w.amit, todo.id, { assignee_id: w.neha.id })).rejects.toBeInstanceOf(AccessDeniedError);
    const raised = await updateWorkTask(w.ctx, w.amit, todo.id, { assignee_id: w.admin.id });
    expect(raised).toMatchObject({ kind: "assigned", raised: true, assignee_id: w.admin.id });

    const forAgent = await taskRecipients(w.ctx, w.amit);
    expect(forAgent[0].id).toBe(w.amit.id);
    expect(forAgent.slice(1).every((r) => r.role === "ADMIN")).toBe(true);
    expect((await taskRecipients(w.ctx, w.admin)).map((r) => r.id)).toEqual(expect.arrayContaining([w.amit.id, w.neha.id]));
  });

  it("keeps admin-given work unflagged", async () => {
    const task = await createWorkTask(w.ctx, w.admin, { title: "Renewal quote for Zenith", assignee_id: w.neha.id });
    expect(task.raised).toBe(false);
  });
});

describe("voice notes", () => {
  it("recognises recorder formats by their bytes", () => {
    expect(sniffAudio(webm())?.ext).toBe("webm");
    expect(sniffAudio(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]))?.ext).toBe("ogg");
    expect(sniffAudio(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]))?.ext).toBe("mp4");
    expect(sniffAudio(new TextEncoder().encode("<script>alert(1)</script>"))).toBeNull();
  });

  it("stores a recording for people who see the task and plays it back only to them", async () => {
    const task = await createWorkTask(w.ctx, w.admin, { title: "Explain the claim delay", assignee_id: w.amit.id });
    await expect(storeTaskVoice(w.ctx, w.neha, task.id, webm())).rejects.toBeInstanceOf(InvalidInputError);
    await expect(storeTaskVoice(w.ctx, w.amit, task.id, new TextEncoder().encode("not audio at all"))).rejects.toBeInstanceOf(
      InvalidInputError,
    );

    const stored = await storeTaskVoice(w.ctx, w.amit, task.id, webm());
    expect(stored.key).toMatch(new RegExp(`^task-voice/${task.id}/.+\\.webm$`));
    const message = await postTaskMessage(w.ctx, w.amit, task.id, {
      body: "The surveyor hasn't visited yet.",
      audio: { key: stored.key, ms: 4200 },
    });
    expect(message).toMatchObject({ via: "voice", audio_key: stored.key, audio_ms: 4200 });

    // A recording from another task can't be attached here.
    await expect(
      postTaskMessage(w.ctx, w.amit, task.id, { body: "x", audio: { key: `task-voice/${task.id + 999}/a.webm`, ms: 1 } }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    const forAdmin = await taskVoice(w.ctx, w.admin, task.id, message.id);
    expect(forAdmin).toMatchObject({ contentType: "audio/webm", size: webm().length, range: null });
    const part = await taskVoice(w.ctx, w.amit, task.id, message.id, { offset: 0, length: 4 });
    expect(part?.range).toEqual({ offset: 0, length: 4 });
    expect(await taskVoice(w.ctx, w.neha, task.id, message.id)).toBeNull();

    // Deleting the task removes the audio too.
    await deleteWorkTask(w.ctx, w.admin, task.id);
    expect(await w.ctx.cards.get(stored.key)).toBeNull();
  });
});

describe("templates", () => {
  it("keeps templates personal unless an admin shares them", async () => {
    const mine = await saveTaskTemplate(w.ctx, w.amit, {
      name: "Follow-up call",
      title: "Call the client back",
      priority: "P3",
      tags: "Follow up, Call",
      due_in_days: 1,
    });
    expect(mine).toMatchObject({ owner_id: w.amit.id, shared: false, tags: "follow up, call", due_in_days: 1 });
    await expect(saveTaskTemplate(w.ctx, w.amit, { name: "Team", title: "x", shared: true })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(saveTaskTemplate(w.ctx, w.amit, { name: "Bad", title: "x", due_in_days: 400 })).rejects.toBeInstanceOf(InvalidInputError);

    const team = await saveTaskTemplate(w.ctx, w.admin, { name: "GMC renewal", title: "Re-quote the GMC renewal", priority: "P1", shared: true });
    expect((await listTaskTemplates(w.ctx, w.amit)).map((t) => t.id)).toEqual(expect.arrayContaining([mine.id, team.id]));
    expect((await listTaskTemplates(w.ctx, w.neha)).map((t) => t.id)).toEqual([team.id]);

    // Only the owner (or an admin, for shared ones) can change or delete.
    await expect(saveTaskTemplate(w.ctx, w.neha, { id: mine.id, name: "Hijack", title: "x" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(deleteTaskTemplate(w.ctx, w.amit, team.id)).rejects.toBeInstanceOf(AccessDeniedError);
    const renamed = await saveTaskTemplate(w.ctx, w.amit, { id: mine.id, name: "Call back", title: "Call the client back" });
    expect(renamed.name).toBe("Call back");
    await deleteTaskTemplate(w.ctx, w.amit, mine.id);
    expect((await listTaskTemplates(w.ctx, w.amit)).map((t) => t.id)).toEqual([team.id]);
  });
});
