// Turns the transform result into SQL for the web app's Cloudflare D1 database:
//
//   import.sql  loads everything. Run it with
//                 npx wrangler d1 execute DB --remote --file import.sql
//               D1 runs an uploaded file as one unit: if any statement fails,
//               the database goes back to how it was and nothing is written.
//               Duplicate flags and renewal reminders are computed the way the
//               app's data layer (src/server/data/leads.ts, milestones.ts) does
//               for a new lead, but original creation times are kept.
//   check.sql   read-only. Before the import it shows whether the database is
//               ready and which web account each old agent will map to; after
//               it, what was imported.
//
// D1 has no procedural SQL, so a check that must stop the import inserts into a
// guard table whose CHECK constraint fails; the constraint's name is the error
// message the person running it sees.

import { normalizeCompanyName } from "./transform.mjs";

const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/\u0000/g, "").replaceAll("'", "''")}'`);
const str = (v) => (v === null || v === undefined ? "" : String(v)).trim();
const email = (v) => str(v).toLowerCase();
const bool = (v) => (v ? "1" : "0");
// Values from the export that end up in a "--" comment: quoted, with no line breaks.
const oneLine = (v) => String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ");
const commentValue = (v) => JSON.stringify(String(v)).replace(/[\u2028\u2029]/g, " ");

/** The app stores every time as an ISO string in UTC ("2026-10-02T08:35:00.000Z") and compares them as text. */
export function isoUtc(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) throw new Error(`Unreadable time from the transform: ${value}`);
  return date.toISOString();
}
const ts = (v) => (v ? lit(isoUtc(v)) : NOW);
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const agentRef = (key) => (key ? `(select profile_id from _firebase_import_agents where name_key = ${lit(key)})` : "null");

// Mirrors agentKey() in transform.mjs: lower case, runs of white space as one space.
// SQLite has no regular expressions, so tabs and line breaks become spaces and
// repeated halving collapses runs of up to 64 spaces.
function sqlNameKey(column) {
  let s = `replace(replace(replace(trim(${column}), char(9), ' '), char(10), ' '), char(13), ' ')`;
  for (let i = 0; i < 6; i++) s = `replace(${s}, '  ', ' ')`;
  return `lower(${s})`;
}
const SQL_NAME_KEY = sqlNameKey("p.full_name");
// Profiles an old agent name may match. Only an admin account can take the old
// app's built-in "admin" login, so an agent who calls themselves Admin does not.
const SQL_NAME_ELIGIBLE = `(${SQL_NAME_KEY} <> 'admin' or p.role = 'ADMIN')`;
const ACTIVE_ADMINS = "(select count(*) from profiles p where p.role = 'ADMIN' and p.is_active)";

function agentValues(agents) {
  return agents.map(
    (a) => `(${lit(a.key)}, ${lit(a.name)}, ${lit(a.email)}, ${bool(a.match === "unassigned")}, ${bool(a.required)}, ${a.leads})`,
  );
}

// Guard columns: inserting 0 fails the import with the constraint's name as the message.
const GUARDS = {
  not_imported: "The Firebase data is already imported. Run undo.sql first if you need to import again",
  migrated: "The database has no app tables yet. Deploy the app (it applies the migrations) before importing",
  agents_ok: "An old agent who owns leads has no web account. Run check.sql to see who, create the account, then import again",
};

export function buildImportSql(result, { sourceLabel = "firebase export", generatedAt = new Date().toISOString() } = {}) {
  const { imported, events, agents } = result;
  const notes = imported.reduce((n, l) => n + l.leadNotes.length, 0);
  const out = [];
  const push = (s) => out.push(s);

  push(`-- Firebase -> Cloudflare D1 import, generated ${oneLine(generatedAt)} from ${oneLine(sourceLabel)}.`);
  push(`-- ${imported.length} leads, ${notes} notes, ${events.length} calendar events.`);
  push("-- Run check.sql first, then:");
  push("--   npx wrangler d1 execute DB --remote --file import.sql");
  push("-- If any statement fails, D1 puts the database back as it was: nothing is written.");
  push("-- undo.sql removes exactly what this created, if needed straight afterwards.");
  push("");

  push("-- Stops the import (see the constraint names) when the database is not ready.");
  push("drop table if exists _firebase_import_guard;");
  push("create table _firebase_import_guard (");
  push(
    Object.entries(GUARDS)
      .map(([col, message]) => `  ${col} integer constraint ${JSON.stringify(message)} check (${col} is null or ${col})`)
      .join(",\n"),
  );
  push(");");
  push("insert into _firebase_import_guard (migrated)");
  push("  select count(*) = 2 from sqlite_master where type = 'table' and name in ('leads', 'renewal_milestone_offsets');");
  push("insert into _firebase_import_guard (not_imported)");
  push("  select not exists (select 1 from app_settings where key = 'firebase_import');");
  push("");

  push("-- Old agent names and the web account each one maps to.");
  push("drop table if exists _firebase_import_agents;");
  push("create table _firebase_import_agents (");
  push("  name_key text primary key,");
  push("  display_name text not null,");
  push("  email text,");
  push("  unassigned integer not null,");
  push("  required integer not null,");
  push("  lead_count integer not null,");
  push("  profile_id text");
  push(");");
  if (agents.length) {
    push("insert into _firebase_import_agents (name_key, display_name, email, unassigned, required, lead_count) values");
    push(`  ${agentValues(agents).join(",\n  ")};`);
  }
  push("update _firebase_import_agents set profile_id = (select p.id from profiles p where p.email = _firebase_import_agents.email)");
  push("where email is not null;");
  push("update _firebase_import_agents set profile_id = (");
  push(`  select min(p.id) from profiles p where ${SQL_NAME_ELIGIBLE} and ${SQL_NAME_KEY} = _firebase_import_agents.name_key`);
  push(")");
  push("where email is null and not unassigned");
  push(`  and (select count(*) from profiles p where ${SQL_NAME_ELIGIBLE} and ${SQL_NAME_KEY} = _firebase_import_agents.name_key) = 1;`);
  push("-- The old app's built-in \"admin\" login is the administrator: when no account");
  push("-- is called Admin, use the only active admin account.");
  push("update _firebase_import_agents set profile_id = (select p.id from profiles p where p.role = 'ADMIN' and p.is_active)");
  push(`where profile_id is null and email is null and not unassigned and name_key = 'admin' and ${ACTIVE_ADMINS} = 1;`);
  push("insert into _firebase_import_guard (agents_ok)");
  push("  select not exists (select 1 from _firebase_import_agents where required and profile_id is null);");
  push("");

  push("-- What the import created, for undo.sql.");
  push("create table firebase_import_leads (legacy_id text primary key, lead_id integer not null);");
  push("create table firebase_import_events (event_id integer primary key);");
  push("");

  // Each new row is the table's highest id: nothing else writes during the import.
  const newLead = "(select max(id) from leads)";
  for (const l of imported) {
    const agent = agentRef(l.agentKey);
    const created = ts(l.createdAt);
    push(`-- legacy ${commentValue(l.legacyId)}`);
    push("insert into leads (");
    push("  client_name, client_name_normalized, type, business_type, policy_product, sub_product_name, renewal_date,");
    push("  poc_name, poc_designation, poc_contact_number, poc_email_id,");
    push("  poc2_name, poc2_designation, poc2_contact_number, poc2_email_id,");
    push("  notes, status, assigned_agent_id, assigned_at, created_at, updated_at");
    push(") values (");
    push(
      `  ${lit(str(l.clientName))}, ${lit(normalizeCompanyName(str(l.clientName)))}, ${lit(l.type)}, ${lit(l.businessType)}, ${lit(l.policyProduct)}, ${lit(l.subProductName)}, ${lit(l.renewalDate)},`,
    );
    // The same clean-up the data layer's tidy() applies to a new lead.
    push(`  ${lit(l.pocName)}, ${lit(str(l.pocDesignation) || "poc")}, ${lit(l.pocContactNumber)}, ${lit(email(l.pocEmailId))},`);
    push(`  ${lit(l.poc2Name)}, ${lit(l.poc2Designation)}, ${lit(l.poc2ContactNumber)}, ${lit(email(l.poc2EmailId))},`);
    // Keep each lead's original assignment time instead of the import time, so My
    // Day does not list every imported lead as a new assignment.
    push(`  ${lit(l.notes)}, ${lit(l.status)}, ${agent}, case when ${agent} is not null then ${created} end, ${created}, ${created}`);
    push(");");
    push(`insert into firebase_import_leads (legacy_id, lead_id) values (${lit(l.legacyId)}, ${newLead});`);
    // A note signed by someone with a web account carries that account's name, as
    // the app signs new notes.
    for (const n of l.leadNotes) {
      push(
        `insert into lead_notes (lead_id, agent_id, agent_name, content, created_at) values (${newLead}, ${agentRef(n.agentKey)}, coalesce((select full_name from profiles where id = ${agentRef(n.agentKey)}), ${lit(n.agentName)}), ${lit(n.content)}, ${ts(n.createdAt)});`,
      );
    }
    push("");
  }

  push("-- Duplicate flags, as the app sets them for a new lead: a lead whose normalized");
  push("-- name matches an earlier lead (already in the app, or imported before it) is");
  push("-- flagged with the names of the agents handling the earlier ones.");
  push("update leads set is_duplicate = 1, duplicate_label = 'Duplicate: Already being processed by agent(s) [' || (");
  push("  select group_concat(name, ', ') from (");
  push("    select distinct coalesce(p.full_name, 'Unassigned') as name from leads e");
  push("    left join profiles p on p.id = e.assigned_agent_id");
  push("    where e.client_name_normalized = leads.client_name_normalized and e.id < leads.id");
  push("    order by name");
  push("  )");
  push(") || ']'");
  push("where id in (select lead_id from firebase_import_leads)");
  push("  and exists (select 1 from leads e where e.client_name_normalized = leads.client_name_normalized and e.id < leads.id);");
  push("");

  push("-- Renewal countdown events, as src/server/data/milestones.ts makes them: one DUE");
  push("-- event at the renewal due time (IST) and a background reminder at each offset");
  push("-- still in the future.");
  const due = `strftime('%Y-%m-%dT%H:%M:%fZ', l.renewal_date || ' ' || coalesce((select json_extract(value, '$') from app_settings where key = 'renewal_due_time'), '10:00'), '-330 minutes')`;
  const title = (prefix) => `substr(${prefix} || l.client_name || ' (' || l.policy_product || ')', 1, 300)`;
  push("insert into events (lead_id, title, event_timestamp, milestone, is_system_generated, is_background_reminder, assigned_agent_id)");
  push(`select l.id, ${title("'Renewal due: '")}, ${due}, 'DUE', 1, 0, l.assigned_agent_id`);
  push("from leads l join firebase_import_leads m on m.lead_id = l.id");
  push("where l.renewal_date is not null order by l.id;");
  push("insert into events (lead_id, title, event_timestamp, milestone, is_system_generated, is_background_reminder, assigned_agent_id)");
  push("select lead_id, title, at, milestone, 1, 1, assigned_agent_id from (");
  push(
    `  select l.id as lead_id, ${title("o.milestone || ' renewal reminder: '")} as title, o.milestone, o.sort_order, l.assigned_agent_id,`,
  );
  push(`    strftime('%Y-%m-%dT%H:%M:%fZ', ${due}, '-' || o.offset_seconds || ' seconds') as at`);
  push("  from leads l join firebase_import_leads m on m.lead_id = l.id cross join renewal_milestone_offsets o");
  push("  where l.renewal_date is not null");
  push(`) where at > ${NOW} order by lead_id, sort_order;`);
  push("");
  push("-- The old app never closed its renewal-due entries, so every renewal date more");
  push("-- than 30 days past would open as an overdue task and bury today's work on My");
  push("-- Day. Close those as of their due date; the lead keeps its renewal date, so");
  push("-- overdue renewals still show in analytics and on the lead.");
  push("update events set is_completed = 1, completed_at = event_timestamp");
  push("where lead_id in (select lead_id from firebase_import_leads) and is_system_generated and milestone = 'DUE'");
  push(`  and event_timestamp < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days');`);
  push("");

  if (notes) {
    push("-- Old notes were already seen in the old app; don't light up everyone's unread badge.");
    push("insert or ignore into lead_note_reads (note_id, user_id)");
    push("select n.id, p.id from lead_notes n");
    push("join firebase_import_leads m on m.lead_id = n.lead_id");
    push("cross join profiles p;");
    push("");
  }

  for (const e of events) {
    const leadId = e.leadLegacyId ? `(select lead_id from firebase_import_leads where legacy_id = ${lit(e.leadLegacyId)})` : "null";
    push(
      `insert into events (lead_id, title, event_timestamp, notes, is_completed, assigned_agent_id, created_at) values (${leadId}, ${lit(e.title)}, ${lit(isoUtc(e.eventTimestamp))}, ${lit(e.notes)}, ${bool(e.isCompleted)}, ${agentRef(e.agentKey)}, ${ts(e.createdAt)});`,
    );
    push("insert into firebase_import_events (event_id) values ((select max(id) from events));");
  }
  if (events.length) push("");

  const marker = { source: sourceLabel, generated_at: generatedAt, leads: imported.length, notes, events: events.length };
  push("-- Marks the import as done: a second run is refused, and undo.sql knows when it ran.");
  push("insert into app_settings (key, value, description) values (");
  push("  'firebase_import',");
  push(`  json_set(${lit(JSON.stringify(marker))}, '$.imported_at', ${NOW}),`);
  push("  'Set by the one-time import from the old app''s Firebase database; blocks a second run and lets undo.sql remove it'");
  push(");");
  push("");
  push("drop table _firebase_import_agents;");
  push("drop table _firebase_import_guard;");
  push("");
  return out.join("\n");
}

export function buildCheckSql(result, { generatedAt = new Date().toISOString() } = {}) {
  const { imported, agents } = result;
  const out = [];
  const push = (s) => out.push(s);
  push(`-- Read-only checks for the Firebase import (generated ${oneLine(generatedAt)}). Changes nothing.`);
  push("-- Run before import.sql; every row should say ok before you import:");
  push("--   npx wrangler d1 execute DB --remote --file check.sql");
  push("");
  push("with agents (name_key, display_name, email, unassigned, required, lead_count) as (");
  push(agents.length ? `  values\n  ${agentValues(agents).join(",\n  ")}` : "  select null, null, null, 0, 0, 0 where 0");
  push("),");
  push("matches as (");
  push("  select a.*,");
  push("    (select count(*) from profiles p where a.email is not null and p.email = a.email) as by_email,");
  push(`    (select count(*) from profiles p where ${SQL_NAME_ELIGIBLE} and ${SQL_NAME_KEY} = a.name_key) as by_name,`);
  push(`    case when a.name_key = 'admin' then ${ACTIVE_ADMINS} else 0 end as admins,`);
  push("    (select group_concat(p.full_name || ' <' || p.email || '>' || case when p.is_active then '' else ' (inactive)' end, ', ')");
  push(`       from profiles p where (a.email is not null and p.email = a.email) or (a.email is null and ${SQL_NAME_ELIGIBLE} and ${SQL_NAME_KEY} = a.name_key)) as accounts,`);
  push("    (select group_concat(p.full_name || ' <' || p.email || '>', ', ') from profiles p where p.role = 'ADMIN' and p.is_active) as admin_accounts");
  push("  from agents a");
  push(")");
  push("select 1 as ord, 'Database ready' as check_name,");
  push("  case when (select count(*) from sqlite_master where type = 'table' and name in ('leads', 'renewal_milestone_offsets')) = 2");
  push("       then 'ok' else 'deploy the app first (it applies the migrations)' end as status,");
  push("  '' as detail");
  push("union all");
  push("select 2, 'Import status',");
  push("  case when exists (select 1 from app_settings where key = 'firebase_import') then 'already imported' else 'ok' end,");
  push("  coalesce((select 'Imported ' || json_extract(value, '$.leads') || ' leads at ' || json_extract(value, '$.imported_at') from app_settings where key = 'firebase_import'),");
  push(`    'Ready to import ${imported.length} leads')`);
  push("union all");
  push("select 3, 'Leads already in the web app', 'ok',");
  push("  (select count(*) from leads) || ' (imported leads for the same companies will be flagged as duplicates)'");
  push("union all");
  push("select 4, 'Agent ' || m.display_name || ' (' || m.lead_count || ' leads)',");
  push("  case");
  push("    when m.unassigned then 'ok'");
  push("    when m.email is not null and m.by_email = 1 then 'ok'");
  push("    when m.email is null and m.by_name = 1 then 'ok'");
  push("    when m.email is null and m.by_name = 0 and m.admins = 1 then 'ok'");
  push("    when not m.required then 'ok'");
  push("    when m.email is not null then 'no web account with email ' || m.email");
  push("    when m.by_name > 1 then 'several web accounts have this name'");
  push("    when m.name_key = 'admin' then m.admins || ' active admin accounts'");
  push("    else 'no web account with this full name'");
  push("  end,");
  push("  case");
  push("    when m.unassigned then 'imported as Unassigned (by choice)'");
  push("    when coalesce(m.accounts, '') <> '' and (m.by_email = 1 or (m.email is null and m.by_name = 1)) then 'maps to ' || m.accounts");
  push("    when m.email is null and m.by_name = 0 and m.admins = 1 then 'maps to the admin account ' || m.admin_accounts");
  push("    when not m.required then 'no account; their notes keep the name only'");
  push("    when m.name_key = 'admin' and m.by_name = 0 then 'map Admin to one admin email in agents.json, e.g. {\"Admin\": \"<admin email>\"}, and regenerate'");
  push("    else coalesce('matches ' || m.accounts, 'add them on the Team page with the full name ' || m.display_name || ', or map the name to an email in agents.json')");
  push("  end");
  push("from matches m");
  push("order by 1, 2;");
  push("");
  return out.join("\n");
}
