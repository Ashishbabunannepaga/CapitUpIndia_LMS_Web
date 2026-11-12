import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigration, freshD1, migrationFiles } from "../test-d1";

// Migration 0009 runs against the live leads, events and notifications. It
// must keep every row (a table rebuild would cascade-delete events and notes
// on D1), copy each lead's product into `product`, fold "Active Client" into
// "Closed Won" without touching updated_at, and mark old notifications as
// already pushed so nobody gets a burst of stale alerts.

let db: D1Database;
let dispose: () => Promise<void>;
const migration = migrationFiles().find((f) => f.startsWith("0009_"))!;

beforeAll(async () => {
  ({ db, dispose } = await freshD1({ stopBefore: migration }));
  const now = Date.now();
  await db
    .prepare("insert into user (id, name, email, email_verified, created_at, updated_at) values ('a1', 'a1', 'a1@capitup.test', 1, ?, ?)")
    .bind(now, now)
    .run();
  await db.prepare("insert into profiles (id, email, full_name) values ('a1', 'a1@capitup.test', 'Agent One')").run();
  await db
    .prepare(
      `insert into leads (client_name, client_name_normalized, policy_product, status, assigned_agent_id, updated_at) values
        ('Motor Co', 'motor co', 'Motor', 'Active Client', 'a1', '2026-01-01T00:00:00.000Z'),
        ('Health Co', 'health co', 'Health', 'Quoted', 'a1', '2026-01-02T00:00:00.000Z')`,
    )
    .run();
  await db.prepare("insert into events (lead_id, title, event_timestamp) values (1, 'Visit', '2027-01-10T04:30:00.000Z')").run();
  await db.prepare("insert into lead_notes (lead_id, agent_id, agent_name, content) values (1, 'a1', 'Agent One', 'Called')").run();
  await db
    .prepare("insert into notifications (user_id, kind, title, lead_id, event_id, created_at) values ('a1', 'renewal_reminder', 'T-3 Days', 1, 1, '2026-11-01T00:00:00.000Z')")
    .run();
  await applyMigration(db, migration);
}, 60_000);

afterAll(async () => {
  await dispose?.();
});

describe("migration 0009", () => {
  it("keeps every lead, event, note and notification, and the notification's link", async () => {
    const counts = await db
      .prepare(
        "select (select count(*) from leads) leads, (select count(*) from events) events, (select count(*) from lead_notes) notes, (select count(event_id) from notifications) notifications",
      )
      .first();
    expect(counts).toEqual({ leads: 2, events: 1, notes: 1, notifications: 1 });
  });

  it("copies the product, folds Active Client into Closed Won, and leaves updated_at alone", async () => {
    const rows = await db.prepare("select product, status, updated_at from leads order by id").all();
    expect(rows.results).toEqual([
      { product: "Motor", status: "Closed Won", updated_at: "2026-01-01T00:00:00.000Z" },
      { product: "Health", status: "Quoted", updated_at: "2026-01-02T00:00:00.000Z" },
    ]);
  });

  it("defaults new leads to Not Specified, refuses unknown products, and still stamps updated_at on edits", async () => {
    const row = await db
      .prepare("insert into leads (client_name, client_name_normalized) values ('New Co', 'new co') returning product")
      .first<{ product: string }>();
    expect(row?.product).toBe("Not Specified");
    await expect(db.prepare("update leads set product = 'Pet' where id = 2").run()).rejects.toThrow(/constraint/i);
    await db.prepare("update leads set product = 'Not Specified' where id = 2").run();
    const edited = await db.prepare("select updated_at from leads where id = 2").first<{ updated_at: string }>();
    expect(edited?.updated_at).not.toBe("2026-01-02T00:00:00.000Z");
  });

  it("makes existing events tasks and accepts meetings only as the other kind", async () => {
    expect(await db.prepare("select kind from events").first()).toEqual({ kind: "task" });
    await db.prepare("update events set kind = 'meeting' where id = 1").run();
    await expect(db.prepare("update events set kind = 'party' where id = 1").run()).rejects.toThrow(/constraint/i);
  });

  it("counts old notifications as pushed, and adds the push subscriptions table", async () => {
    expect(await db.prepare("select pushed_at from notifications").first()).toEqual({ pushed_at: "2026-11-01T00:00:00.000Z" });
    await expect(
      db.prepare("insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ('a1', 'http://insecure', 'k', 'a')").run(),
    ).rejects.toThrow(/constraint/i);
  });
});
