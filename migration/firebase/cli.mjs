#!/usr/bin/env node
// Dry run of the Firebase -> Supabase migration.
//
//   node migration/firebase/cli.mjs --input export.json [--input leads.json ...]
//        [--agents agents.json] [--out migration/firebase/out]
//
// Reads a Firebase Realtime Database JSON export (the whole database, or the
// separate /leads and /events nodes) and writes:
//   out/report.md   what would be imported, flagged and skipped
//   out/report.json the same, machine-readable
//   out/import.sql  one transaction that loads it; never run by this script
//   out/check.sql   read-only readiness check (agent accounts, migrations)
//
// It never connects to Firebase or Supabase. From /users it reads only the
// user names: the values are plaintext passwords and are never read into the
// output, printed or migrated.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import { buildReport } from "./report.mjs";
import { buildCheckSql, buildImportSql } from "./sql.mjs";
import { transform } from "./transform.mjs";

const { values } = parseArgs({
  options: {
    input: { type: "string", multiple: true },
    agents: { type: "string" },
    out: { type: "string", default: "migration/firebase/out" },
  },
});

if (!values.input?.length) {
  console.error("Usage: npm run migrate:firebase -- --input <export.json> [--agents agents.json] [--out dir]");
  process.exit(1);
}

let leads;
let events;
let userNames = [];
for (const file of values.input) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const name = basename(file).toLowerCase();
  if (data && typeof data === "object" && ("leads" in data || "events" in data || "users" in data)) {
    leads = data.leads ?? leads;
    events = data.events ?? events;
    if (data.users && typeof data.users === "object") userNames = Object.keys(data.users);
  } else if (name.includes("event")) {
    events = data;
  } else if (name.includes("user")) {
    userNames = Object.keys(data ?? {});
  } else {
    leads = data;
  }
}
if (!leads) {
  console.error("No leads found. Pass the full database export or the /leads node export.");
  process.exit(1);
}

const agentEmails = values.agents ? JSON.parse(readFileSync(values.agents, "utf8")) : {};
const result = transform({ leads, events, userNames, agentEmails });
const meta = { sourceLabel: values.input.map((f) => basename(f)).join(", "), generatedAt: new Date().toISOString() };

const outDir = resolve(values.out);
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/report.md`, buildReport(result, meta));
writeFileSync(`${outDir}/report.json`, JSON.stringify({ ...meta, ...result }, null, 2));
writeFileSync(`${outDir}/import.sql`, buildImportSql(result, meta));
writeFileSync(`${outDir}/check.sql`, buildCheckSql(result, meta));

const flagged = result.imported.filter((l) => l.flags.length).length;
const needed = result.agents.filter((a) => a.required).map((a) => a.name);
console.log(`Leads: ${result.imported.length} to import (${flagged} flagged), ${result.skipped.length} skipped`);
console.log(`Duplicate companies: ${result.duplicateGroups.length}`);
console.log(`Notes: ${result.imported.reduce((n, l) => n + l.leadNotes.length, 0)}, events: ${result.events.length}`);
console.log(`Agents who need a web account: ${needed.join(", ") || "none"}`);
console.log(`Wrote ${outDir}/report.md, report.json, check.sql and import.sql`);
