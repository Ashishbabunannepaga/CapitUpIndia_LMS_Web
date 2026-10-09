import { expect, test } from "@playwright/test";

import { searchTerms } from "@/lib/lead-filters";

import { adminClient, anonClient, userClient, userId } from "./fixtures";

// Someone with a valid login can skip the app and call the database API
// directly with the publishable key from the browser. These tests do exactly
// that, through the real auth and API services, and check that the database
// rules hold.

test.describe.configure({ mode: "serial" });

let amitLead: number;
let nehaLead: number;

test.beforeAll(async () => {
  const admin = adminClient();
  await admin.from("leads").delete().like("client_name", "API %");
  const [amit, neha] = await Promise.all([userId("amit"), userId("neha")]);
  const { data, error } = await admin
    .from("leads")
    .insert([
      { client_name: "API Amit Co", assigned_agent_id: amit, poc_name: "Ravi", notes: "" },
      { client_name: "API Neha Co", assigned_agent_id: neha, poc_name: "Sita", notes: "Neha's secret notes" },
    ])
    .select("id, client_name");
  if (error) throw error;
  amitLead = data.find((l) => l.client_name === "API Amit Co")!.id;
  nehaLead = data.find((l) => l.client_name === "API Neha Co")!.id;
});

test("sign-up is closed and anonymous callers see nothing", async () => {
  const anon = anonClient();
  const signUp = await anon.auth.signUp({ email: "intruder@e2e.test", password: "intruder-Password-1" });
  expect(signUp.error).not.toBeNull();

  const { data, error } = await anon.from("leads").select("id");
  expect(error ?? data?.length === 0).toBeTruthy();
  const rpc = await anon.rpc("pipeline_analytics");
  expect(rpc.error).not.toBeNull();
});

test("an agent cannot read another agent's lead, even by id", async () => {
  const amit = await userClient("amit");
  const { data } = await amit.from("leads").select("id, client_name");
  expect(data?.map((l) => l.client_name)).toContain("API Amit Co");
  expect(data?.map((l) => l.client_name)).not.toContain("API Neha Co");

  const byId = await amit.from("leads").select("*").eq("id", nehaLead).maybeSingle();
  expect(byId.data).toBeNull();
});

test("an agent's writes to another agent's lead change nothing", async () => {
  const amit = await userClient("amit");
  const update = await amit.from("leads").update({ notes: "hijacked" }).eq("id", nehaLead).select();
  expect(update.data ?? []).toHaveLength(0);
  const del = await amit.from("leads").delete().eq("id", nehaLead).select();
  expect(del.data ?? []).toHaveLength(0);
  const note = await amit.from("lead_notes").insert({ lead_id: nehaLead, content: "spy", agent_name: "x" });
  expect(note.error).not.toBeNull();

  const { data } = await adminClient().from("leads").select("notes").eq("id", nehaLead).single();
  expect(data?.notes).toBe("Neha's secret notes");
});

test("an agent cannot take over or forge ownership fields", async () => {
  const amit = await userClient("amit");
  const neha = await userId("neha");

  const forOther = await amit.from("leads").insert({ client_name: "API Gift Co", assigned_agent_id: neha });
  expect(forOther.error).not.toBeNull();

  const reassign = await amit.from("leads").update({ assigned_agent_id: neha }).eq("id", amitLead);
  expect(reassign.error).not.toBeNull();
  const dupFlag = await amit.from("leads").update({ is_duplicate: true }).eq("id", amitLead);
  expect(dupFlag.error).not.toBeNull();

  const promote = await amit.from("profiles").update({ role: "ADMIN" }).eq("id", await userId("amit"));
  expect(promote.error).not.toBeNull();

  const job = await amit.rpc("deliver_due_reminders");
  expect(job.error).not.toBeNull();
  const roundRobin = await amit.rpc("next_round_robin_agents", { p_count: 1 });
  expect(roundRobin.error).not.toBeNull();
});

test("notes are signed by the server, not by whatever the client sends", async () => {
  const amit = await userClient("amit");
  const { data, error } = await amit
    .from("lead_notes")
    // agent_id is not writable in the app's types; send it anyway, as an attacker would.
    .insert({ lead_id: amitLead, content: "Quote sent", agent_name: "The CEO", agent_id: await userId("neha") } as never)
    .select("agent_name, agent_id")
    .single();
  expect(error).toBeNull();
  expect(data).toEqual({ agent_name: "Amit E2E", agent_id: await userId("amit") });
});

test("search input cannot widen the filter", async () => {
  const amit = await userClient("amit");
  const malicious = "x%,client_name.ilike.%API Neha%,(id.gt.0)";
  const terms = searchTerms(malicious);
  const filter = terms.map((t) => `client_name.ilike.%${t}%`).join(",");
  const { data, error } = await amit.from("leads").select("client_name").or(filter);
  expect(error).toBeNull();
  expect(data ?? []).toHaveLength(0);
});

test("a deactivated agent's still-open session is shut out", async () => {
  const amit = await userClient("amit");
  const admin = adminClient();
  const id = await userId("amit");
  await admin.from("profiles").update({ is_active: false }).eq("id", id);
  try {
    const leads = await amit.from("leads").select("id");
    expect(leads.data ?? []).toHaveLength(0);
    const similar = await amit.rpc("find_similar_leads", { p_client_name: "API Neha Co" });
    expect(similar.error?.code).toBe("42501");
    const create = await amit.from("leads").insert({ client_name: "API Late Co", assigned_agent_id: id });
    expect(create.error).not.toBeNull();
  } finally {
    await admin.from("profiles").update({ is_active: true }).eq("id", id);
  }
});

test("duplicate warnings work through the API for active agents", async () => {
  const amit = await userClient("amit");
  const { data, error } = await amit.rpc("find_similar_leads", { p_client_name: "API Neha Company Pvt Ltd" });
  expect(error).toBeNull();
  expect(data?.[0]).toMatchObject({ lead_id: nehaLead, assigned_agent_name: "Neha E2E" });
});
