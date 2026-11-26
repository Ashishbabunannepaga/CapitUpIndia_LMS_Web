import { vi } from "vitest";
vi.mock("server-only", () => ({}));

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { notifications, workTasks } from "../../db/schema";
import type { WhatsAppAlert } from "../../whatsapp/client";
import { validSignature } from "../../whatsapp/client";
import { handleWhatsAppReply, normalizeWhatsAppPhone, sendWhatsAppAlerts, setWhatsApp } from "../whatsapp";
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
