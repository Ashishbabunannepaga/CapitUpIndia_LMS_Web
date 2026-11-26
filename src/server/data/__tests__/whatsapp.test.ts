import { vi } from "vitest";
vi.mock("server-only", () => ({}));

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { notifications, workTaskMessages, workTasks } from "../../db/schema";
import type { WhatsAppAlert } from "../../whatsapp/client";
import { validSignature } from "../../whatsapp/client";
import {
  claimWhatsAppInbound,
  clientAutoReply,
  handleWhatsAppReply,
  normalizeWhatsAppPhone,
  sendWhatsAppAlerts,
  setWhatsApp,
  setWhatsAppClientReply,
  WHATSAPP_HELP,
  type WhatsAppHelpers,
} from "../whatsapp";
import { createWorkTask } from "../work-tasks";
import { testWorld } from "./helpers";

describe("normalizeWhatsAppPhone", () => {
  it("adds 91 to Indian mobiles and keeps full numbers", () => {
    expect(normalizeWhatsAppPhone("98765 43210")).toBe("919876543210");
    expect(normalizeWhatsAppPhone("+91 98765-43210")).toBe("919876543210");
    expect(normalizeWhatsAppPhone("098765 43210")).toBe("919876543210");
    expect(() => normalizeWhatsAppPhone("12345")).toThrow();
  });
});

describe("validSignature", () => {
  it("accepts Meta's HMAC and rejects anything else", async () => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s3cret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("{}")));
    const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await validSignature("s3cret", "{}", `sha256=${hex}`)).toBe(true);
    expect(await validSignature("s3cret", "{ }", `sha256=${hex}`)).toBe(false);
    expect(await validSignature("s3cret", "{}", null)).toBe(false);
  });
});

describe("WhatsApp task alerts", () => {
  let w: Awaited<ReturnType<typeof testWorld>>;
  beforeAll(async () => {
    w = await testWorld();
  });
  afterAll(() => w.dispose());

  it("only admins set numbers", async () => {
    await expect(setWhatsApp(w.ctx, w.amit, w.amit.id, "9876543210", true)).rejects.toThrow();
  });

  it("sends task alerts once to people with it on, and Done / Snooze replies act as them", async () => {
    await setWhatsApp(w.ctx, w.admin, w.amit.id, "98765 43210", true);
    const task = await createWorkTask(w.ctx, w.admin, { title: "Zenith quote", assignee_id: w.amit.id });
    await createWorkTask(w.ctx, w.admin, { title: "Neha has no WhatsApp", assignee_id: w.neha.id });

    const sent: WhatsAppAlert[] = [];
    const send = async (a: WhatsAppAlert) => {
      sent.push(a);
      return { ok: true as const, id: `wamid.${sent.length}` };
    };
    expect(await sendWhatsAppAlerts(w.ctx, send)).toBe(1);
    expect(await sendWhatsAppAlerts(w.ctx, send)).toBe(0);
    expect(sent[0]).toMatchObject({ to: "919876543210", taskId: task.id });
    expect(sent[0].title).toMatch(/^New task from/);

    // Strangers get nothing back; a snooze then done from Amit's phone act on the task.
    expect(await handleWhatsAppReply(w.ctx, { from: "919999999999", payload: `done:${task.id}` })).toBeNull();
    expect(await handleWhatsAppReply(w.ctx, { from: "919876543210", payload: `snooze:${task.id}` })).toMatch(/Snoozed/);
    let row = await w.ctx.db.query.workTasks.findFirst({ where: eq(workTasks.id, task.id) });
    expect(row?.snoozed_until).toBeTruthy();
    const [n] = await w.ctx.db.select().from(notifications).where(eq(notifications.whatsapp_msg_id, "wamid.1"));
    expect(await handleWhatsAppReply(w.ctx, { from: "919876543210", text: "done", contextId: n.whatsapp_msg_id! })).toMatch(/Done/);
    row = await w.ctx.db.query.workTasks.findFirst({ where: eq(workTasks.id, task.id) });
    expect(row?.status).toBe("done");
  });

  it("can't act on someone else's task", async () => {
    const other = await createWorkTask(w.ctx, w.admin, { title: "For Neha", assignee_id: w.neha.id });
    const answer = await handleWhatsAppReply(w.ctx, { from: "919876543210", payload: `done:${other.id}` });
    expect(answer).not.toMatch(/^Done/);
    const row = await w.ctx.db.query.workTasks.findFirst({ where: eq(workTasks.id, other.id) });
    expect(row?.status).toBe("todo");
  });
});

describe("WhatsApp messages from the team", () => {
  let w: Awaited<ReturnType<typeof testWorld>>;
  const AMIT = "919876543210";
  const ASHA = "919800000001";
  beforeAll(async () => {
    w = await testWorld();
    await setWhatsApp(w.ctx, w.admin, w.amit.id, "98765 43210", true);
    await setWhatsApp(w.ctx, w.admin, w.admin.id, "98000 00001", true);
  });
  afterAll(() => w.dispose());

  /** Sends Amit an alert for a new task and returns the task and the alert's wamid. */
  async function alerted(title: string) {
    const task = await createWorkTask(w.ctx, w.admin, { title, assignee_id: w.amit.id });
    let id = "";
    await sendWhatsAppAlerts(w.ctx, async (a) => {
      id = `wamid.${a.taskId}.${Math.random()}`;
      return { ok: true as const, id };
    });
    return { task, wamid: id };
  }

  it("answers the test message's buttons and help", async () => {
    expect(await handleWhatsAppReply(w.ctx, { from: AMIT, payload: "done:0" })).toMatch(/test message/);
    expect(await handleWhatsAppReply(w.ctx, { from: AMIT, text: "Hi" })).toBe(WHATSAPP_HELP);
  });

  it("puts a reply to an alert into that task's chat, as the person", async () => {
    const { task, wamid } = await alerted("Collect KYC from Zenith");
    expect(await handleWhatsAppReply(w.ctx, { from: AMIT, text: "Asked them, PAN coming tomorrow", contextId: wamid })).toMatch(/Added to the chat/);
    const [m] = await w.ctx.db
      .select()
      .from(workTaskMessages)
      .where(and(eq(workTaskMessages.task_id, task.id), eq(workTaskMessages.author_id, w.amit.id)));
    expect(m).toMatchObject({ author_id: w.amit.id, body: "Asked them, PAN coming tomorrow", via: "text" });
    // Someone else's alert id does nothing for Asha's number.
    expect(await handleWhatsAppReply(w.ctx, { from: ASHA, text: "hello there", contextId: wamid }, {})).toBe(WHATSAPP_HELP);
  });

  it("keeps a voice-note reply with its transcript, and spoken commands work", async () => {
    const { task, wamid } = await alerted("Call Zenith about the claim");
    const ogg = new Uint8Array(4000);
    ogg.set([0x4f, 0x67, 0x67, 0x53]);
    const helpers: WhatsAppHelpers = { fetchAudio: async () => ogg, transcribe: async () => "Spoke to them, claim form sent" };
    expect(await handleWhatsAppReply(w.ctx, { from: AMIT, audioId: "123", contextId: wamid }, helpers)).toMatch(/Added to the chat/);
    const [m] = await w.ctx.db
      .select()
      .from(workTaskMessages)
      .where(and(eq(workTaskMessages.task_id, task.id), eq(workTaskMessages.author_id, w.amit.id)));
    expect(m.via).toBe("voice");
    expect(m.audio_key).toMatch(new RegExp(`^task-voice/${task.id}/.+\\.ogg$`));
    expect(m.body).toBe("Spoke to them, claim form sent");

    const done = { ...helpers, transcribe: async () => "Done." };
    expect(await handleWhatsAppReply(w.ctx, { from: AMIT, audioId: "124", contextId: wamid }, done)).toMatch(/^Done/);
    const row = await w.ctx.db.query.workTasks.findFirst({ where: eq(workTasks.id, task.id) });
    expect(row?.status).toBe("done");
  });

  it("creates tasks from a message under the app's rules", async () => {
    let asked = "";
    const helpers: WhatsAppHelpers = {
      drafts: async (_person, request) => {
        asked = request;
        return [
          { title: "Send the GMC quote", description: "", assignee_id: w.amit.id, priority: "P1", due_date: "", tags: ["gmc"] },
          { title: "Chase Neha's renewal", description: "", assignee_id: w.neha.id, priority: "P2", due_date: "", tags: [] },
        ];
      },
    };
    const answer = await handleWhatsAppReply(w.ctx, { from: ASHA, text: "Amit: send the GMC quote today" }, helpers);
    expect(asked).toBe("Amit: send the GMC quote today");
    expect(answer).toMatch(/Created 2 tasks/);
    expect(answer).toMatch(/for Amit Agent/);

    // An agent can't give work to another agent: that draft is refused, the rest is made.
    const fromAmit = await handleWhatsAppReply(w.ctx, { from: AMIT, text: "todo: send the GMC quote" }, helpers);
    expect(fromAmit).toMatch(/Created 1 task/);
    expect(fromAmit).toMatch(/Not created/);
  });

  it("answers questions with the person's own facts, and says when AI is off", async () => {
    let facts = "";
    const answer = await handleWhatsAppReply(w.ctx, { from: AMIT, text: "what is overdue?" }, {
      ask: async (_p, _q, f) => {
        facts = f;
        return "Nothing is overdue.";
      },
    });
    expect(answer).toBe("Nothing is overdue.");
    expect(facts).toMatch(/Person: Amit Agent/);
    expect(await handleWhatsAppReply(w.ctx, { from: AMIT, text: "what is overdue?" }, { ask: async () => Promise.reject(new Error("AI is busy")) })).toBe("AI is busy");
  });

  it("handles each delivery once", async () => {
    expect(await claimWhatsAppInbound(w.ctx, "wamid.same")).toBe(true);
    expect(await claimWhatsAppInbound(w.ctx, "wamid.same")).toBe(false);
  });

  it("sends the admins' client auto-reply at most once a day per number", async () => {
    await expect(setWhatsAppClientReply(w.ctx, w.amit, "Hi")).rejects.toThrow();
    expect(await clientAutoReply(w.ctx, "919111111111")).toBeNull();
    await setWhatsAppClientReply(w.ctx, w.admin, "Thanks, we will call you back.");
    const at = new Date("2026-11-26T05:00:00Z");
    expect(await clientAutoReply(w.ctx, "919111111111", at)).toBe("Thanks, we will call you back.");
    expect(await clientAutoReply(w.ctx, "919111111111", at)).toBeNull();
    expect(await clientAutoReply(w.ctx, "919111111111", new Date("2026-11-27T05:00:00Z"))).toBe("Thanks, we will call you back.");
  });
});
