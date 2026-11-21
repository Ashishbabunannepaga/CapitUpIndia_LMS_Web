import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigration, freshD1, migrationFiles } from "../test-d1";

// Migration 0012 runs against the live leads. It must keep every lead, event,
// note and transaction (no `leads` rebuild), fold Renewed into Closed Won in
// the new pipeline_status column without touching updated_at, number today's
// clients and give them a client code for their current policy year, and
// give existing transactions their product and code.

let db: D1Database;
let dispose: () => Promise<void>;
const migration = migrationFiles().find((f) => f.startsWith("0012_"))!;

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
      `insert into leads (client_name, client_name_normalized, lead_status, renewal_date, product, assigned_agent_id, updated_at) values
        ('Won Co', 'won co', 'Closed Won', '2027-03-01', 'Health', 'a1', '2026-01-01T00:00:00.000Z'),
        ('Quoted Co', 'quoted co', 'Quoted', null, 'Motor', 'a1', '2026-01-02T00:00:00.000Z'),
        ('Renewed Co', 'renewed co', 'Renewed', null, 'Life', 'a1', '2025-06-03T00:00:00.000Z'),
        ('Lost Co', 'lost co', 'Closed Lost', '2027-01-01', 'Fire or Property', 'a1', '2026-01-04T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      "insert into events (lead_id, title, event_timestamp, milestone, is_system_generated) values (1, 'Renewal due: Won Co', '2027-03-01T04:30:00.000Z', 'DUE', 1)",
    )
    .run();
  await db.prepare("insert into lead_notes (lead_id, agent_id, agent_name, content) values (1, 'a1', 'Agent One', 'Called')").run();
  await db
    .prepare(
      "insert into lead_transactions (lead_id, transaction_date, policy_start_date, policy_status) values (1, '2026-03-01', '2026-03-01', 'Policy Received')",
    )
    .run();
  await applyMigration(db, migration);
}, 60_000);

afterAll(async () => {
  await dispose?.();
});

describe("migration 0012", () => {
  it("keeps every lead, event, note and transaction", async () => {
    const counts = await db
      .prepare(
        "select (select count(*) from leads) leads, (select count(*) from events) events, (select count(*) from lead_notes) notes, (select count(*) from lead_transactions) tx",
      )
      .first();
    expect(counts).toEqual({ leads: 4, events: 1, notes: 1, tx: 1 });
  });

  it("folds Renewed into Closed Won, numbers the clients and leaves updated_at alone", async () => {
    const rows = await db.prepare("select pipeline_status, client_no, client_code, updated_at from leads order by id").all();
    expect(rows.results).toEqual([
      { pipeline_status: "Closed Won", client_no: 1, client_code: "CAP-CLI-2026-0001", updated_at: "2026-01-01T00:00:00.000Z" },
      { pipeline_status: "Quoted", client_no: null, client_code: null, updated_at: "2026-01-02T00:00:00.000Z" },
      // No renewal date: the year it was last changed.
      { pipeline_status: "Closed Won", client_no: 2, client_code: "CAP-CLI-2025-0002", updated_at: "2025-06-03T00:00:00.000Z" },
      { pipeline_status: "Closed Lost", client_no: null, client_code: null, updated_at: "2026-01-04T00:00:00.000Z" },
    ]);
  });

  it("gives existing transactions their product and client code, checked and confirmed as before", async () => {
    const tx = await db.prepare("select product, client_code, kind, verification, insurer, policy_number from lead_transactions").first();
    expect(tx).toEqual({ product: "Health", client_code: "CAP-CLI-2026-0001", kind: "won", verification: "not_checked", insurer: "", policy_number: "" });
  });

  it("refuses unknown statuses and duplicate client numbers, and still stamps updated_at on edits", async () => {
    await db.prepare("update leads set pipeline_status = 'Closed Awaiting Policy' where id = 2").run();
    await expect(db.prepare("update leads set pipeline_status = 'Renewed' where id = 2").run()).rejects.toThrow(/constraint/i);
    await expect(db.prepare("update leads set client_no = 1 where id = 4").run()).rejects.toThrow(/constraint/i);
    await expect(db.prepare("update lead_transactions set verification = 'maybe'").run()).rejects.toThrow(/constraint/i);
    const edited = await db.prepare("select updated_at from leads where id = 2").first<{ updated_at: string }>();
    expect(edited?.updated_at).not.toBe("2026-01-02T00:00:00.000Z");
    const plan = await db.prepare("explain query plan select id from leads where pipeline_status = 'Quoted'").all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toMatch(/pipeline_status_idx/);
  });
});
