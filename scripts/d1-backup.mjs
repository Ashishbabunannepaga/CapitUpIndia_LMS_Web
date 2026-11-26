#!/usr/bin/env node
// Exports the live D1 database to a .sql file through Cloudflare's D1 export
// API (the same thing `wrangler d1 export --remote` does). The database has a
// full-text search table (leads_name_fts), so the export asks for the
// "sqlite3_cli_only" dump: it includes virtual tables and restores with the
// sqlite3 command-line tool (see docs/backups.md for restoring into D1).
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//   node scripts/d1-backup.mjs <output.sql> [database_id]
//
// The database id defaults to the one in wrangler.jsonc. An export briefly
// blocks other queries, so the nightly job runs it at night (India time).

import { readFileSync, writeFileSync } from "node:fs";
import { rewriteUnistr } from "./sql-unistr.mjs";

const [output, idArg] = process.argv.slice(2);
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!output || !token || !account) {
  console.error("Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/d1-backup.mjs <output.sql> [database_id]");
  process.exit(2);
}

function databaseIdFromWrangler() {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const match = text.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/);
  if (!match) throw new Error("No database_id in wrangler.jsonc");
  return match[1];
}

const databaseId = idArg ?? databaseIdFromWrangler();
const url = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/export`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.success === false) {
    const reason = (json.errors ?? []).map((e) => e.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`D1 export API: ${reason}`);
  }
  return json.result;
}

const options = { output_format: "polling", dump_options: { compatibility: "sqlite3_cli_only" } };
let result = await call(options);
const started = Date.now();
while (result.status !== "complete") {
  if (result.status === "error") throw new Error(`D1 export failed: ${result.error ?? JSON.stringify(result.messages ?? [])}`);
  if (Date.now() - started > 15 * 60_000) throw new Error("D1 export did not finish in 15 minutes");
  await sleep(3000);
  result = await call({ ...options, current_bookmark: result.at_bookmark });
}

const signed = result.result?.signed_url;
if (!signed) throw new Error("D1 export finished without a download link");
const dump = await fetch(signed);
if (!dump.ok) throw new Error(`Downloading the export failed: HTTP ${dump.status}`);
const raw = Buffer.from(await dump.arrayBuffer()).toString("utf8");
if (raw.length === 0) throw new Error("The export is empty");
// Plain literals instead of unistr(), so older sqlite3 tools can restore it.
const sql = Buffer.from(rewriteUnistr(raw), "utf8");
writeFileSync(output, sql);
console.log(`Exported D1 ${databaseId} to ${output} (${(sql.length / 1024).toFixed(0)} KB).`);
