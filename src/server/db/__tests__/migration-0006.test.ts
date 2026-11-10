import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigration, freshD1, migrationFiles } from "../test-d1";

// Migration 0006 runs against the live leads table. It must keep every lead,
// event and note (a table rebuild would cascade-delete them on D1), copy each
// lead's type into lead_type, and leave updated_at alone.

let db: D1Database;
let dispose: () => Promise<void>;
const migration = migrationFiles().find((f) => f.startsWith("0006_"))!;

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
      `insert into leads (client_name, client_name_normalized, type, renewal_date, assigned_agent_id, updated_at) values
        ('Old Renewal Co', 'old renewal co', 'Renewal', '2027-01-10', 'a1', '2026-01-01T00:00:00.000Z'),
        ('Old New Co', 'old new co', 'New', null, 'a1', '2026-01-02T00:00:00.000Z')`,
    )
    .run();
  await db.prepare("insert into events (lead_id, title, event_timestamp) values (1, 'Renewal due', '2027-01-10T04:30:00.000Z')").run();
  await db.prepare("insert into lead_notes (lead_id, agent_id, agent_name, content) values (1, 'a1', 'Agent One', 'Called')").run();
  await applyMigration(db, migration);
}, 60_000);

afterAll(async () => {
  await dispose?.();
});

describe("migration 0006", () => {
  it("keeps every lead, event and note", async () => {
    const counts = await db
      .prepare("select (select count(*) from leads) leads, (select count(*) from events) events, (select count(*) from lead_notes) notes")
      .first();
    expect(counts).toEqual({ leads: 2, events: 1, notes: 1 });
  });

  it("copies the type into lead_type without touching updated_at, and adds an empty RM", async () => {
    const rows = await db.prepare("select lead_type, updated_at, relationship_manager from leads order by id").all();
    expect(rows.results).toEqual([
      { lead_type: "Renewal", updated_at: "2026-01-01T00:00:00.000Z", relationship_manager: "" },
      { lead_type: "New", updated_at: "2026-01-02T00:00:00.000Z", relationship_manager: "" },
    ]);
  });

  it("accepts Rollover, refuses unknown types, and still stamps updated_at on edits", async () => {
    await db.prepare("update leads set lead_type = 'Rollover' where id = 2").run();
    const row = await db.prepare("select lead_type, updated_at from leads where id = 2").first<{ lead_type: string; updated_at: string }>();
    expect(row?.lead_type).toBe("Rollover");
    expect(row?.updated_at).not.toBe("2026-01-02T00:00:00.000Z");
    await expect(db.prepare("update leads set lead_type = 'Transfer' where id = 2").run()).rejects.toThrow(/constraint/i);
  });
});
