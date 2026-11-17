import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigration, freshD1, migrationFiles } from "../test-d1";

// Migration 0011 runs against the live leads (1,000+), their renewal events
// and notes. It must keep every row (a `leads` table rebuild would
// cascade-delete events and notes on D1), copy each lead's status into
// `lead_status` without touching updated_at, allow "Renewed", let notes be
// edited, and add the transactions table.

let db: D1Database;
let dispose: () => Promise<void>;
const migration = migrationFiles().find((f) => f.startsWith("0011_"))!;

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
      `insert into leads (client_name, client_name_normalized, status, renewal_date, assigned_agent_id, updated_at) values
        ('Won Co', 'won co', 'Closed Won', '2026-03-01', 'a1', '2026-01-01T00:00:00.000Z'),
        ('Lost Co', 'lost co', 'Closed Lost', null, 'a1', '2026-01-02T00:00:00.000Z'),
        ('Quoted Co', 'quoted co', 'Quoted', null, 'a1', '2026-01-03T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      "insert into events (lead_id, title, event_timestamp, milestone, is_system_generated) values (1, 'Renewal due: Won Co', '2026-03-01T04:30:00.000Z', 'DUE', 1)",
    )
    .run();
  await db.prepare("insert into lead_notes (lead_id, agent_id, agent_name, content) values (1, 'a1', 'Agent One', 'Called')").run();
  await applyMigration(db, migration);
}, 60_000);

afterAll(async () => {
  await dispose?.();
});

describe("migration 0011", () => {
  it("keeps every lead, event and note", async () => {
    const counts = await db
      .prepare("select (select count(*) from leads) leads, (select count(*) from events) events, (select count(*) from lead_notes) notes")
      .first();
    expect(counts).toEqual({ leads: 3, events: 1, notes: 1 });
  });

  it("copies each status into lead_status and leaves updated_at alone", async () => {
    const rows = await db.prepare("select lead_status, updated_at from leads order by id").all();
    expect(rows.results).toEqual([
      { lead_status: "Closed Won", updated_at: "2026-01-01T00:00:00.000Z" },
      { lead_status: "Closed Lost", updated_at: "2026-01-02T00:00:00.000Z" },
      { lead_status: "Quoted", updated_at: "2026-01-03T00:00:00.000Z" },
    ]);
  });

  it("accepts Renewed, refuses unknown statuses, and still stamps updated_at on edits", async () => {
    await db.prepare("update leads set lead_status = 'Renewed' where id = 3").run();
    await expect(db.prepare("update leads set lead_status = 'Won' where id = 3").run()).rejects.toThrow(/constraint/i);
    const edited = await db.prepare("select lead_status, updated_at from leads where id = 3").first<{ lead_status: string; updated_at: string }>();
    expect(edited?.lead_status).toBe("Renewed");
    expect(edited?.updated_at).not.toBe("2026-01-03T00:00:00.000Z");
    const plan = await db.prepare("explain query plan select id from leads where lead_status = 'Renewed'").all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toMatch(/leads_lead_status_idx|leads_assigned_lead_status_idx/);
  });

  it("lets notes record an edit and adds transactions that go with their lead", async () => {
    expect(await db.prepare("select edited_at from lead_notes").first()).toEqual({ edited_at: null });
    await db
      .prepare("insert into lead_transactions (lead_id, transaction_date, policy_start_date, policy_status) values (1, '2026-03-01', '2026-03-01', 'Policy Received')")
      .run();
    await expect(
      db.prepare("insert into lead_transactions (lead_id, transaction_date, policy_status) values (1, '2026-02-30', 'Policy Received')").run(),
    ).rejects.toThrow(/constraint/i);
    await expect(
      db.prepare("insert into lead_transactions (lead_id, transaction_date, policy_status) values (1, '2026-03-01', 'Lost in post')").run(),
    ).rejects.toThrow(/constraint/i);
    await db.prepare("delete from leads where id = 1").run();
    expect(await db.prepare("select count(*) n from lead_transactions").first()).toEqual({ n: 0 });
  });
});
