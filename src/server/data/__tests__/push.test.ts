import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AccessDeniedError, InvalidInputError } from "../errors";
import { assignLead, createLead, notifyBulkAssignment, updateLead } from "../leads";
import { recentNotifications } from "../notifications";
import { countPushSubscriptions, pushPendingNotifications, removePushSubscription, savePushSubscription, type PushSender } from "../push";
import { testWorld } from "./helpers";

// Browser push: people manage only their own browsers, every new bell
// notification is pushed once to its owner's browsers, and assignments made
// by someone else now reach the bell (and so the phone).

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

const sub = (name: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  keys: { p256dh: `BPk${name}Key`, auth: `auth${name}` },
});

const sqlRows = async <T>(query: string, ...binds: unknown[]) =>
  (await w.d1.prepare(query).bind(...binds).all<T>()).results;

function recordingSender(status = 201) {
  const calls: { endpoint: string; title: string; url: string }[] = [];
  const send: PushSender = async (target, message) => {
    calls.push({ endpoint: target.endpoint, title: message.title, url: message.url });
    return { ok: status < 300, status, gone: status === 404 || status === 410 };
  };
  return { calls, send };
}

describe("push subscriptions", () => {
  it("are saved per browser, validated, and moved when someone else signs in on that browser", async () => {
    await savePushSubscription(w.ctx, w.amit, sub("amit-laptop"), "Chrome on Windows");
    await savePushSubscription(w.ctx, w.amit, sub("amit-laptop"), "Chrome on Windows"); // Same browser again: still one.
    expect(await countPushSubscriptions(w.ctx, w.amit)).toBe(1);

    await expect(savePushSubscription(w.ctx, w.amit, { endpoint: "http://evil.test/x", keys: { p256dh: "a", auth: "b" } })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(savePushSubscription(w.ctx, w.amit, { endpoint: "https://x.test/1", keys: { p256dh: "<script>", auth: "b" } })).rejects.toBeInstanceOf(
      InvalidInputError,
    );

    await savePushSubscription(w.ctx, w.neha, sub("shared-tablet"));
    await savePushSubscription(w.ctx, w.amit, sub("shared-tablet"));
    expect(await countPushSubscriptions(w.ctx, w.neha)).toBe(0);
    expect(await countPushSubscriptions(w.ctx, w.amit)).toBe(2);

    // Neha cannot remove Amit's browser; Amit can.
    await removePushSubscription(w.ctx, w.neha, sub("shared-tablet").endpoint);
    expect(await countPushSubscriptions(w.ctx, w.amit)).toBe(2);
    await removePushSubscription(w.ctx, w.amit, sub("shared-tablet").endpoint);
    expect(await countPushSubscriptions(w.ctx, w.amit)).toBe(1);
  });
});

describe("assignment notifications", () => {
  it("tell an agent when someone else gives them a lead, not when they take their own", async () => {
    const before = (await recentNotifications(w.ctx, w.neha)).items.length;
    const id = await createLead(w.ctx, w.admin, { client_name: "Assigned Push Co", assigned_agent_id: w.neha.id, renewal_date: "2031-01-15" });
    let bell = (await recentNotifications(w.ctx, w.neha)).items;
    expect(bell).toHaveLength(before + 1);
    expect(bell[0]).toMatchObject({ kind: "other", lead_id: id, title: "New lead assigned: Assigned Push Co" });
    expect(bell[0].body).toBe("Asha Admin assigned it to you. Renews 15 Jan 2031.");

    // Reassigning tells the new owner; an agent's own new lead tells nobody.
    await assignLead(w.ctx, w.admin, id, w.amit.id);
    expect((await recentNotifications(w.ctx, w.amit)).items[0]).toMatchObject({ lead_id: id, title: "New lead assigned: Assigned Push Co" });
    const amitCount = (await recentNotifications(w.ctx, w.amit)).items.length;
    await createLead(w.ctx, w.amit, { client_name: "Self Made Co" });
    await updateLead(w.ctx, w.amit, id, { notes: "edited" });
    expect((await recentNotifications(w.ctx, w.amit)).items).toHaveLength(amitCount);

    // Bulk imports send one summary instead of one per lead.
    await createLead(w.ctx, w.admin, { client_name: "Quiet Import Co", assigned_agent_id: w.neha.id, notifyOwner: false });
    bell = (await recentNotifications(w.ctx, w.neha)).items;
    expect(bell.some((n) => n.title.includes("Quiet Import Co"))).toBe(false);
    await notifyBulkAssignment(w.ctx, w.admin, w.neha.id, 12, "a bulk import");
    expect((await recentNotifications(w.ctx, w.neha)).items[0]).toMatchObject({ title: "12 new leads assigned to you", lead_id: null });
    await expect(notifyBulkAssignment(w.ctx, w.amit, w.neha.id, 1, "x")).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe("pushing notifications", () => {
  it("pushes each new notification once, only to its owner's browsers, and forgets gone browsers", async () => {
    const at = new Date();
    // Clear the backlog from earlier tests.
    await pushPendingNotifications(w.ctx, recordingSender().send, at);

    await savePushSubscription(w.ctx, w.neha, sub("neha-phone"));
    const id = await createLead(w.ctx, w.admin, { client_name: "Buzz Co", assigned_agent_id: w.neha.id });

    const first = recordingSender();
    expect(await pushPendingNotifications(w.ctx, first.send, new Date())).toBe(1);
    expect(first.calls).toEqual([{ endpoint: sub("neha-phone").endpoint, title: "New lead assigned: Buzz Co", url: `/leads/${id}` }]);

    // Already pushed: nothing more.
    const again = recordingSender();
    expect(await pushPendingNotifications(w.ctx, again.send, new Date())).toBe(0);
    expect(again.calls).toEqual([]);

    // The phone unsubscribed (410): the subscription is deleted.
    await createLead(w.ctx, w.admin, { client_name: "Gone Co", assigned_agent_id: w.neha.id });
    const gone = recordingSender(410);
    expect(await pushPendingNotifications(w.ctx, gone.send, new Date())).toBe(0);
    expect(gone.calls).toHaveLength(1);
    expect(await countPushSubscriptions(w.ctx, w.neha)).toBe(0);
  });

  it("skips notifications older than an hour and marks people without browsers as done", async () => {
    await w.d1
      .prepare("insert into notifications (user_id, kind, title, created_at) values (?, 'other', 'Old news', '2020-01-01T00:00:00.000Z')")
      .bind(w.amit.id)
      .run();
    await w.d1.prepare("insert into notifications (user_id, kind, title) values (?, 'other', 'Nobody listening')").bind(w.admin.id).run();
    const sender = recordingSender();
    await pushPendingNotifications(w.ctx, sender.send, new Date());
    expect(sender.calls.map((c) => c.title)).not.toContain("Old news");
    expect(await sqlRows("select id from notifications where pushed_at is null")).toEqual([]);
  });
});
