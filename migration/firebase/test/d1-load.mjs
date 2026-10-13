#!/usr/bin/env node
// Generates import.sql from the sample export and runs it with wrangler against a
// throwaway local D1 that has the app's real migrations, then checks what landed.
// The files run exactly as they will on the day (`wrangler d1 execute --file`),
// only with --local instead of --remote.
//
//   node migration/firebase/test/d1-load.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HERE = join(ROOT, "migration/firebase");
const TMP = mkdtempSync(join(tmpdir(), "firebase-d1-"));
const STATE = join(TMP, "state");
const OUT = join(TMP, "out");
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const wrangler = (...args) =>
  spawnSync("npx", ["wrangler", "d1", ...args, "--local", "--persist-to", STATE], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_D1_WARNING: "true", WRANGLER_SEND_METRICS: "false", CI: "1" },
  });

/** Runs a SQL file the way the guide does; returns { ok, output }. */
function runFile(file) {
  const r = wrangler("execute", "DB", "--file", file, "--yes");
  return { ok: r.status === 0, output: `${r.stdout}\n${r.stderr}` };
}

/** Runs one or more statements and returns the last statement's rows. */
function query(sql, { file = false } = {}) {
  const r = wrangler("execute", "DB", file ? "--file" : "--command", sql, "--json");
  const parsed = JSON.parse(r.stdout || "{}");
  if (r.status !== 0 || parsed.error) throw new Error(`query failed: ${sql}\n${r.stdout}${r.stderr}`);
  return parsed.at(-1).results;
}
const one = (sql) => query(sql)[0];

function ok(name, fn) {
  fn();
  console.log(`ok - ${name}`);
}

function generate(input, out, agents) {
  execFileSync("node", [join(HERE, "cli.mjs"), "--input", input, "--out", out, ...(agents ? ["--agents", agents] : [])], {
    cwd: ROOT,
    stdio: "ignore",
  });
}

const addUser = (id, email, name, role = "AGENT", active = 1) =>
  `insert into user (id, name, email, created_at, updated_at) values ('${id}', '${name.replaceAll("'", "''")}', '${email}', 0, 0);
   insert into profiles (id, email, full_name, role, is_active) values ('${id}', '${email}', '${name.replaceAll("'", "''")}', '${role}', ${active});`;

const r0 = wrangler("migrations", "apply", "DB");
assert.equal(r0.status, 0, r0.stderr);
generate(join(HERE, "fixtures/sample-export.json"), OUT, join(HERE, "fixtures/agents.json"));
const importSql = join(OUT, "import.sql");
const checkSql = join(OUT, "check.sql");
const checkRows = () => query(checkSql, { file: true });

ok("no /users value leaks into the output", () => {
  for (const f of ["import.sql", "check.sql", "report.md", "report.json"]) {
    assert.doesNotMatch(readFileSync(join(OUT, f), "utf8"), /FIXTURE-SECRET/, f);
  }
});

// An agent who calls themselves Admin never takes the old admin login's work.
query(addUser("u-agent-admin", "agent-admin@example.com", "Admin"));

ok("refuses to run before the agents who own leads have accounts, and writes nothing", () => {
  const r = runFile(importSql);
  assert.equal(r.ok, false);
  assert.match(r.output, /An old agent who owns leads has no web account/);
  assert.deepEqual(
    one("select (select count(*) from leads) leads, (select count(*) from sqlite_master where name like 'firebase_import%') maps"),
    { leads: 0, maps: 0 },
  );
});

ok("check.sql names each missing account", () => {
  const problems = checkRows().filter((r) => r.status !== "ok");
  assert.deepEqual(
    problems.map((r) => [r.check_name, r.status]),
    [
      ["Agent Admin (0 leads)", "0 active admin accounts"],
      ["Agent Amit Kumar (1 leads)", "no web account with this full name"],
      ["Agent Neha (4 leads)", "no web account with email neha@example.com"],
    ],
  );
  const admin = problems.find((r) => r.check_name.startsWith("Agent Admin"));
  assert.equal(admin.detail, 'map Admin to one admin email in agents.json, e.g. {"Admin": "<admin email>"}, and regenerate');
});

ok("two accounts with the same name are ambiguous, never guessed", () => {
  query(addUser("u-amit1", "amit1@example.com", "Amit  Kumar") + addUser("u-amit2", "amit2@example.com", "amit kumar"));
  const row = checkRows().find((r) => r.check_name.startsWith("Agent Amit"));
  assert.equal(row.status, "several web accounts have this name");
  assert.equal(runFile(importSql).ok, false);
  query("delete from profiles where id = 'u-amit2'; delete from user where id = 'u-amit2'");
});

query(addUser("u-neha", "neha@example.com", "Neha Sharma") + addUser("u-admin", "admin@example.com", "Ash", "ADMIN"));

ok("check.sql is all ok once accounts exist", () => {
  const problems = checkRows().filter((r) => r.status !== "ok");
  assert.deepEqual(problems, []);
});

ok("import runs", () => {
  const r = runFile(importSql);
  assert.ok(r.ok, r.output);
});

const lead = (name, cols) => one(`select ${cols} from leads where client_name = '${name}'`);

ok("leads, statuses and creation times", () => {
  assert.deepEqual(
    one("select count(*) n, group_concat(client_name || '=' || status, ',') s from (select * from leads order by id)"),
    {
      n: 7,
      s: "Renee Systems Pvt Ltd=Follow-up,renee systems=Follow-up,Kaveri Textiles=Closed Won,Ganga Motors=Prospect,Old Renewal Co=Active Client,Jan First Ltd=Prospect,Chiranjeevi=Prospect",
    },
  );
  assert.equal(lead("Renee Systems Pvt Ltd", "created_at").created_at, new Date(1790000000 * 1000).toISOString());
});

ok("agents matched by full name, by email, and null means unassigned", () => {
  const owner = (name) =>
    one(`select p.email from leads l left join profiles p on p.id = l.assigned_agent_id where l.client_name = '${name}'`).email;
  assert.equal(owner("Renee Systems Pvt Ltd"), "amit1@example.com");
  assert.equal(owner("renee systems"), "neha@example.com");
  assert.equal(owner("Ganga Motors"), null);
  assert.deepEqual(
    one(`select
      sum(assigned_agent_id is not null and assigned_at = created_at) = sum(assigned_agent_id is not null) kept,
      sum(assigned_agent_id is null and assigned_at is not null) stray from leads`),
    { kept: 1, stray: 0 },
  );
});

ok("designations, normalized names and the search index", () => {
  assert.equal(lead("Renee Systems Pvt Ltd", "poc_designation").poc_designation, "Director");
  assert.equal(lead("renee systems", "poc_designation").poc_designation, "poc");
  assert.equal(lead("Renee Systems Pvt Ltd", "client_name_normalized").client_name_normalized, "renee systems");
  assert.equal(one("select count(*) n from leads_name_fts where leads_name_fts match 'kaveri'").n, 1);
});

ok("second Renee flagged as a duplicate naming the first one's agent", () => {
  assert.deepEqual(
    query("select client_name, is_duplicate, duplicate_label from leads where client_name like 'renee%' order by id"),
    [
      { client_name: "Renee Systems Pvt Ltd", is_duplicate: 0, duplicate_label: "" },
      { client_name: "renee systems", is_duplicate: 1, duplicate_label: "Duplicate: Already being processed by agent(s) [Amit  Kumar]" },
    ],
  );
});

ok("notes split into lead_notes with IST times, read for everyone", () => {
  assert.deepEqual(
    query("select agent_name, agent_id is not null linked, content, created_at from lead_notes order by created_at"),
    [
      { agent_name: "Amit  Kumar", linked: 1, content: "Called Rajesh, asked for quote", created_at: "2026-10-02T08:35:00.000Z" },
      { agent_name: "Ash", linked: 1, content: "Please prioritise", created_at: "2026-10-03T03:30:00.000Z" },
    ],
  );
  assert.equal(one("select count(*) n from lead_note_reads").n, 2 * 4);
  assert.equal(lead("Renee Systems Pvt Ltd", "notes").notes, "Met at the expo.");
});

ok("renewal milestones match what the app makes for a new lead", () => {
  const rows = query(`select e.milestone, e.title, e.event_timestamp, e.is_background_reminder bg, e.assigned_agent_id agent
    from events e join leads l on l.id = e.lead_id where l.client_name = 'Renee Systems Pvt Ltd' and e.is_system_generated order by e.event_timestamp`);
  const renewal = lead("Renee Systems Pvt Ltd", "renewal_date, assigned_agent_id");
  const due = new Date(`${renewal.renewal_date}T10:00:00+05:30`);
  const offsets = query("select milestone, offset_seconds from renewal_milestone_offsets order by sort_order");
  const expected = [
    ...offsets
      .map((o) => ({ milestone: o.milestone, at: new Date(due.getTime() - o.offset_seconds * 1000) }))
      .filter((o) => o.at > new Date())
      .map((o) => ({ milestone: o.milestone, title: `${o.milestone} renewal reminder: Renee Systems Pvt Ltd (Health)`, event_timestamp: o.at.toISOString(), bg: 1 })),
    { milestone: "DUE", title: "Renewal due: Renee Systems Pvt Ltd (Health)", event_timestamp: due.toISOString(), bg: 0 },
  ].sort((a, b) => a.event_timestamp.localeCompare(b.event_timestamp));
  assert.deepEqual(rows.map((r) => ({ milestone: r.milestone, title: r.title, event_timestamp: r.event_timestamp, bg: r.bg })), expected);
  assert.ok(rows.every((r) => r.agent === renewal.assigned_agent_id));
  assert.equal(
    one("select renewal_date || '/' || (select count(*) from events e where e.lead_id = l.id and e.is_system_generated) v from leads l where client_name = 'Jan First Ltd'").v,
    `2027-01-01/${expected.length}`,
  );
});

ok("long-past renewal due task closed on its due date; future one left open", () => {
  assert.equal(
    one(`select is_completed and completed_at = event_timestamp v from events e join leads l on l.id = e.lead_id
      where l.client_name = 'Old Renewal Co' and e.milestone = 'DUE'`).v,
    1,
  );
  assert.equal(
    one(`select is_completed v from events e join leads l on l.id = e.lead_id where l.client_name = 'Renee Systems Pvt Ltd' and e.milestone = 'DUE'`).v,
    0,
  );
});

ok("hand-made events imported with their lead and owner", () => {
  assert.deepEqual(
    query(`select title, strftime('%Y-%m-%d %H:%M', event_timestamp, '+330 minutes') at, is_completed done from events where not is_system_generated order by id`),
    [
      { title: "Site visit", at: "2026-10-20 15:00", done: 0 },
      { title: "Team meeting", at: "2026-10-22 10:00", done: 1 },
      { title: "call Hathnoora SI", at: "2026-11-05 10:00", done: 0 },
      { title: "Kaveri visit", at: "2026-11-06 11:00", done: 0 },
    ],
  );
  assert.equal(
    one("select p.email from events e join profiles p on p.id = e.assigned_agent_id where e.title = 'call Hathnoora SI'").email,
    "admin@example.com",
  );
  assert.equal(
    one("select l.client_name from events e join leads l on l.id = e.lead_id where e.title = 'Kaveri visit'").client_name,
    "Kaveri Textiles",
  );
});

ok("calendar entry for an overwritten client kept in notes; quotes survive", () => {
  assert.match(
    lead("Chiranjeevi", "notes").notes,
    /Old calendar entry for this record: "Renewal due: Awaze pvt Ltd \(Health\)" on 2026-08-07 \(POC: Chiranjeevi \(9154230981\)\. Agent: Neha\.\)/,
  );
  assert.equal(lead("Kaveri Textiles", "poc_name").poc_name, "O'Brien");
});

ok("no reminder is due straight away", () => {
  assert.equal(
    one(`select count(*) n from events where is_background_reminder and reminder_sent_at is null
      and event_timestamp <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).n,
    0,
  );
});

ok("scratch tables are gone and the marker records the import", () => {
  assert.equal(one("select count(*) n from sqlite_master where name like '\\_firebase%' escape '\\'").n, 0);
  assert.deepEqual(
    one("select json_extract(value, '$.leads') leads, json_extract(value, '$.events') events, json_extract(value, '$.imported_at') is not null at from app_settings where key = 'firebase_import'"),
    { leads: 7, events: 4, at: 1 },
  );
  assert.equal(checkRows().find((r) => r.check_name === "Import status").status, "already imported");
});

ok("a second run is refused and changes nothing", () => {
  const r = runFile(importSql);
  assert.equal(r.ok, false);
  assert.match(r.output, /already imported/);
  assert.equal(one("select count(*) n from leads").n, 7);
});

ok("undo refuses once people have worked on the import", () => {
  query(`insert into leads (client_name, client_name_normalized) values ('Walk-in Co', 'walk in co');
    insert into lead_notes (lead_id, agent_name, content, created_at)
      select id, 'Ash', 'Called back', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 minute') from leads where client_name = 'Kaveri Textiles'`);
  const r = runFile(join(HERE, "undo.sql"));
  assert.equal(r.ok, false);
  assert.match(r.output, /People have worked on the imported leads/);
  assert.equal(one("select count(*) n from leads").n, 8);
  query("delete from lead_notes where content = 'Called back'");
});

ok("undo removes exactly the import", () => {
  const r = runFile(join(HERE, "undo.sql"));
  assert.ok(r.ok, r.output);
  assert.deepEqual(
    one(`select (select group_concat(client_name) from leads) leads, (select count(*) from lead_notes) notes,
      (select count(*) from events) events, (select count(*) from app_settings where key = 'firebase_import') marker,
      (select count(*) from sqlite_master where name like 'firebase_import%') maps`),
    { leads: "Walk-in Co", notes: 0, events: 0, marker: 0, maps: 0 },
  );
});

ok("text in the export stays data", () => {
  const crafted = join(TMP, "crafted.json");
  const pwned = join(TMP, "pwned");
  writeFileSync(
    crafted,
    JSON.stringify({
      leads: {
        x: {
          id: `9\n\\! touch ${pwned}\ndrop table leads; --\u2028select 1`,
          clientName: "Crafted Co'); drop table leads; --",
          status: "Prospect",
          assignedAgent: "Ravi D'Souza",
          createdAt: 1790000000000,
        },
      },
    }),
  );
  const out = join(TMP, "crafted-out");
  generate(crafted, out);
  query(addUser("u-ravi", "dsouza@example.com", "Ravi D'Souza"));
  const r = runFile(join(out, "import.sql"));
  assert.ok(r.ok, r.output);
  assert.ok(!existsSync(pwned));
  assert.equal(
    one("select l.client_name || ' by ' || p.full_name v from leads l join profiles p on p.id = l.assigned_agent_id where l.client_name like 'Crafted%'").v,
    "Crafted Co'); drop table leads; -- by Ravi D'Souza",
  );
  assert.ok(runFile(join(HERE, "undo.sql")).ok);
});

ok("after an undo the import can run again", () => {
  assert.ok(runFile(importSql).ok);
  assert.deepEqual(
    one("select (select count(*) from leads) leads, (select count(*) from lead_notes) notes, (select count(*) from events where not is_system_generated) events"),
    { leads: 8, notes: 2, events: 4 },
  );
});

console.log("All Firebase import checks passed");
