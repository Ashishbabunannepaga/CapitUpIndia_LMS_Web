import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseLeadFilters } from "@/lib/lead-filters";

import { changeStamp } from "../changes";
import { addLeadNote, countLeadsByStatus, createLead, KANBAN_COLUMN_LIMIT, LEAD_PAGE_SIZE, listLeads, setLeadStatus } from "../leads";
import { pipelineAnalytics } from "../analytics";
import { testWorld } from "./helpers";

// The changes that keep requests inside the Workers Free plan: paged lists,
// a per-column board, SQL-side analytics and the change stamp. Access rules
// must hold exactly as before.

let w: Awaited<ReturnType<typeof testWorld>>;
const filters = (q: Record<string, string> = {}) => parseLeadFilters(q);
const setStamp = (value: number) => w.d1.prepare("update change_version set version = ? where id = 1").bind(value).run();

beforeAll(async () => {
  w = await testWorld();
  // Bulk rows straight into D1: enough for two pages and a full board column.
  const rows = LEAD_PAGE_SIZE + 30;
  const insert = w.d1.prepare(
    "insert into leads (client_name, client_name_normalized, assigned_agent_id, created_by, status, renewal_date) values (?, ?, ?, ?, ?, ?)",
  );
  const statements = [];
  for (let i = 0; i < rows; i++) {
    const name = `Paged Co ${String(i).padStart(3, "0")}`;
    statements.push(insert.bind(name, name.toLowerCase(), w.amit.id, w.amit.id, i % 2 ? "Quoted" : "Prospect", null));
  }
  statements.push(insert.bind("Neha Private Co", "neha private co", w.neha.id, w.neha.id, "Prospect", null));
  await w.d1.batch(statements);
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

describe("paged leads list", () => {
  it("returns one page at a time, in order, with nothing lost between pages", async () => {
    const first = await listLeads(w.ctx, w.amit, filters({ sort: "name" }));
    const second = await listLeads(w.ctx, w.amit, filters({ sort: "name", page: "2" }));
    expect(first.leads).toHaveLength(LEAD_PAGE_SIZE);
    expect(first.truncated).toBe(true);
    expect(second.leads).toHaveLength(30);
    expect(second.truncated).toBe(false);
    const names = [...first.leads, ...second.leads].map((l) => l.client_name);
    expect(new Set(names).size).toBe(LEAD_PAGE_SIZE + 30);
    expect(names).toEqual([...names].sort());
  });

  it("never pages into another agent's leads", async () => {
    for (const page of ["1", "2", "3"]) {
      const { leads } = await listLeads(w.ctx, w.amit, filters({ page }));
      expect(leads.every((l) => l.assigned_agent_id === w.amit.id)).toBe(true);
    }
    const neha = await listLeads(w.ctx, w.neha, filters());
    expect(neha.leads.map((l) => l.client_name)).toEqual(["Neha Private Co"]);
  });

  it("ignores nonsense page numbers", () => {
    expect(parseLeadFilters({ page: "-3" }).page).toBe(1);
    expect(parseLeadFilters({ page: "abc" }).page).toBe(1);
    expect(parseLeadFilters({ page: "99999999" }).page).toBe(1);
    expect(parseLeadFilters({ page: "4" }).page).toBe(4);
  });
});

describe("board", () => {
  it("shows at most the column limit per status, flags the cut, and keeps totals right", async () => {
    const { leads, truncated } = await listLeads(w.ctx, w.amit, filters({ view: "kanban" }));
    const per = (status: string) => leads.filter((l) => l.status === status).length;
    expect(per("Prospect")).toBe(KANBAN_COLUMN_LIMIT);
    expect(per("Quoted")).toBe(KANBAN_COLUMN_LIMIT);
    expect(truncated).toBe(true);
    expect(leads.every((l) => l.assigned_agent_id === w.amit.id)).toBe(true);
    const totals = await countLeadsByStatus(w.ctx, w.amit, filters({ view: "kanban" }));
    expect(totals.Prospect + totals.Quoted).toBe(LEAD_PAGE_SIZE + 30);
  });

  it("is not cut when every column fits", async () => {
    const { leads, truncated } = await listLeads(w.ctx, w.neha, filters({ view: "kanban" }));
    expect(leads).toHaveLength(1);
    expect(truncated).toBe(false);
  });
});

describe("analytics counted by D1", () => {
  it("matches the leads each person can see", async () => {
    const amit = await pipelineAnalytics(w.ctx, w.amit);
    expect(amit.total).toBe(LEAD_PAGE_SIZE + 30);
    expect(amit.by_status).toEqual({ Prospect: 65, Quoted: 65 });
    expect(amit.agents.map((a) => a.agent_id)).toEqual([w.amit.id]);
    const admin = await pipelineAnalytics(w.ctx, w.admin);
    expect(admin.total).toBe(LEAD_PAGE_SIZE + 31);
    expect(admin.agents.find((a) => a.agent_id === w.neha.id)?.prospect).toBe(1);
  });
});

describe("change stamp", () => {
  it("moves when a lead, note or status changes, and stays put otherwise", async () => {
    const lead = await createLead(w.ctx, w.amit, { client_name: "Stamp Co" });
    await setStamp(0);
    expect(await changeStamp(w.ctx, w.amit)).toBe(0);
    await setLeadStatus(w.ctx, w.amit, lead, "Quoted");
    const afterStatus = await changeStamp(w.ctx, w.amit);
    expect(afterStatus).toBeGreaterThan(0);

    await setStamp(0);
    await addLeadNote(w.ctx, w.amit, lead, "Called them");
    expect(await changeStamp(w.ctx, w.neha)).toBeGreaterThan(0);

    await setStamp(0);
    await listLeads(w.ctx, w.admin, filters());
    await pipelineAnalytics(w.ctx, w.admin);
    expect(await changeStamp(w.ctx, w.admin)).toBe(0);
  });

  it("is written at most once a second, however many rows change", async () => {
    const now = Math.floor(Date.now() / 1000);
    await setStamp(now + 3600);
    await createLead(w.ctx, w.amit, { client_name: "Same Second Co", renewal_date: "2030-01-01" });
    expect(await changeStamp(w.ctx, w.amit)).toBe(now + 3600);
  });
});
