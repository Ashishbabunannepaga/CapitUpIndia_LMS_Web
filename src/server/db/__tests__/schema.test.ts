import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freshD1 } from "../test-d1";

// The D1 schema on its own: constraints, triggers and the trigram index.
// Access rules are tested with the data layer, not here.

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await freshD1());
  const now = Date.now();
  for (const [id, role] of [
    ["admin-1", "ADMIN"],
    ["agent-1", "AGENT"],
  ]) {
    await db
      .prepare("insert into user (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)")
      .bind(id, id, `${id}@capitup.test`, now, now)
      .run();
    await db
      .prepare("insert into profiles (id, email, full_name, role) values (?, ?, ?, ?)")
      .bind(id, `${id}@capitup.test`, id, role)
      .run();
  }
}, 60_000);

afterAll(async () => {
  await dispose?.();
});

const insertLead = (name: string, normalized: string) =>
  db
    .prepare("insert into leads (client_name, client_name_normalized) values (?, ?) returning id")
    .bind(name, normalized)
    .first<{ id: number }>();

describe("seed data", () => {
  it("has the nine renewal milestones in order", async () => {
    const { results } = await db.prepare("select milestone from renewal_milestone_offsets order by sort_order").all<{ milestone: string }>();
    expect(results.map((r) => r.milestone)).toEqual([
      "T-30 Days",
      "T-10 Days",
      "T-5 Days",
      "T-3 Days",
      "T-24 Hours",
      "T-10 Hours",
      "T-1 Hour",
      "T-30 Minutes",
      "T-5 Minutes",
    ]);
  });

  it("stores settings as JSON", async () => {
    const row = await db.prepare("select value from app_settings where key = 'timezone'").first<{ value: string }>();
    expect(JSON.parse(row!.value)).toBe("Asia/Kolkata");
  });
});

describe("lead constraints", () => {
  const rejects: [string, string, unknown[]][] = [
    ["an unknown status", "insert into leads (client_name, client_name_normalized, status) values ('A', 'a', 'Won')", []],
    ["an unknown product", "insert into leads (client_name, client_name_normalized, policy_product) values ('A', 'a', 'Pet')", []],
    ["a blank client", "insert into leads (client_name, client_name_normalized) values ('   ', '')", []],
    ["an impossible renewal date", "insert into leads (client_name, client_name_normalized, renewal_date) values ('A', 'a', '2026-02-30')", []],
    ["a renewal date in another format", "insert into leads (client_name, client_name_normalized, renewal_date) values ('A', 'a', '15/11/2026')", []],
    ["a bad email", "insert into leads (client_name, client_name_normalized, poc_email_id) values ('A', 'a', 'priya@')", []],
    ["an agent that does not exist", "insert into leads (client_name, client_name_normalized, assigned_agent_id) values ('A', 'a', 'ghost')", []],
  ];
  it.each(rejects)("rejects %s", async (_, statement) => {
    await expect(db.prepare(statement).run()).rejects.toThrow(/constraint/i);
  });

  it("accepts a complete lead and stamps ISO timestamps", async () => {
    const row = await db
      .prepare(
        "insert into leads (client_name, client_name_normalized, renewal_date, poc_email_id, assigned_agent_id) values ('Acme', 'acme', '2028-02-29', 'priya@acme.in', 'agent-1') returning created_at, is_duplicate",
      )
      .first<{ created_at: string; is_duplicate: number }>();
    expect(row!.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(row!.is_duplicate).toBe(0);
  });
});

describe("company name trigram index", () => {
  it("finds leads by fragments of their normalized name and follows renames and deletes", async () => {
    const { id } = (await insertLead("Renee Systems Pvt Ltd", "renee systems"))!;
    const match = (q: string) =>
      db
        .prepare("select rowid as id from leads_name_fts where leads_name_fts match ?")
        .bind(q)
        .all<{ id: number }>()
        .then((r) => r.results.map((x) => x.id));

    expect(await match('"syst"')).toContain(id);
    await db.prepare("update leads set client_name = 'Kaveri Textiles', client_name_normalized = 'kaveri textiles' where id = ?").bind(id).run();
    expect(await match('"syst"')).not.toContain(id);
    expect(await match('"textil"')).toContain(id);
    await db.prepare("delete from leads where id = ?").bind(id).run();
    expect(await match('"textil"')).not.toContain(id);
  });
});

describe("profiles", () => {
  it("never loses the last active admin", async () => {
    await expect(db.prepare("update profiles set role = 'AGENT' where id = 'admin-1'").run()).rejects.toThrow(/last active admin/);
    await expect(db.prepare("update profiles set is_active = 0 where id = 'admin-1'").run()).rejects.toThrow(/last active admin/);
    await expect(db.prepare("delete from profiles where id = 'admin-1'").run()).rejects.toThrow(/last active admin/);
  });

  it("lets an admin step down once another admin exists", async () => {
    await db.prepare("update profiles set role = 'ADMIN' where id = 'agent-1'").run();
    await db.prepare("update profiles set role = 'AGENT' where id = 'admin-1'").run();
    const { results } = await db.prepare("select id from profiles where role = 'ADMIN'").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["agent-1"]);
  });

  it("bumps updated_at on change unless the writer set it", async () => {
    await db.prepare("update profiles set updated_at = '2000-01-01T00:00:00.000Z' where id = 'admin-1'").run();
    await db.prepare("update profiles set full_name = 'Admin One' where id = 'admin-1'").run();
    const row = await db.prepare("select updated_at from profiles where id = 'admin-1'").first<{ updated_at: string }>();
    expect(row!.updated_at > "2026-01-01").toBe(true);
  });

  it("removes a profile with its sign-in account", async () => {
    await db.prepare("delete from user where id = 'admin-1'").run();
    const row = await db.prepare("select count(*) as n from profiles where id = 'admin-1'").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});
