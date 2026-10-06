// Turns the transform result into SQL:
//
//   import.sql  loads everything in one transaction. It runs as the database
//               owner (psql or the Supabase SQL editor), which the guard
//               triggers treat as a privileged session, so original created_at
//               timestamps are kept while duplicate flags and renewal reminders
//               are still computed by the database itself.
//   check.sql   read-only. Before the import it shows whether the database is
//               ready and which web account each old agent will map to; after
//               it, what was imported.

const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/\u0000/g, "").replaceAll("'", "''")}'`);
const ts = (v) => (v ? `${lit(v)}::timestamptz` : "now()");
const agentRef = (key) => (key ? `(select profile_id from firebase_agents where name_key = ${lit(key)})` : "null");

// Mirrors agentKey() in transform.mjs.
const SQL_NAME_KEY = "lower(regexp_replace(btrim(p.full_name), '\\s+', ' ', 'g'))";

function agentValues(agents) {
  return agents.map(
    (a) => `(${lit(a.key)}, ${lit(a.name)}, ${lit(a.email)}, ${a.match === "unassigned"}, ${a.required}, ${a.leads})`,
  );
}

export function buildImportSql(result, { sourceLabel = "firebase export", generatedAt = new Date().toISOString() } = {}) {
  const { imported, events, agents } = result;
  const notes = imported.reduce((n, l) => n + l.leadNotes.length, 0);
  const out = [];
  const push = (s) => out.push(s);

  push(`-- Firebase -> Supabase import, generated ${generatedAt} from ${sourceLabel}.`);
  push(`-- ${imported.length} leads, ${notes} notes, ${events.length} calendar events.`);
  push("-- Run as the database owner, e.g. psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f import.sql,");
  push("-- or paste it into the Supabase SQL editor. Run check.sql first.");
  push("-- Everything happens in one transaction: if any check fails, nothing is written.");
  push("");
  push("begin;");
  push("");
  push("-- Refuse to run twice, or against a database that is missing migrations.");
  push("do $$");
  push("begin");
  push("  if exists (select 1 from public.app_settings where key = 'firebase_import') then");
  push("    raise exception 'The Firebase data has already been imported (see app_settings.firebase_import)';");
  push("  end if;");
  push("  if not exists (");
  push("    select 1 from information_schema.columns");
  push("    where table_schema = 'public' and table_name = 'leads' and column_name = 'assigned_at'");
  push("  ) or not exists (");
  push("    select 1 from pg_trigger where tgrelid = 'public.leads'::regclass and tgname = 'leads_track_assignment'");
  push("  ) then");
  push("    raise exception 'Apply all database migrations (npx supabase db push) before importing';");
  push("  end if;");
  push("end $$;");
  push("");

  push("-- Old agent names and the web account each one maps to.");
  push("create temporary table firebase_agents (");
  push("  name_key text primary key,");
  push("  display_name text not null,");
  push("  email text,");
  push("  unassigned boolean not null,");
  push("  required boolean not null,");
  push("  lead_count integer not null,");
  push("  profile_id uuid");
  push(") on commit drop;");
  if (agents.length) {
    push("insert into firebase_agents (name_key, display_name, email, unassigned, required, lead_count) values");
    push(`  ${agentValues(agents).join(",\n  ")};`);
  }
  push("");
  push("update firebase_agents a set profile_id = p.id");
  push("from public.profiles p");
  push("where a.email is not null and p.email = a.email;");
  push("");
  push("update firebase_agents a set profile_id = m.id");
  push("from (");
  push(`  select ${SQL_NAME_KEY} as name_key, (array_agg(p.id))[1] as id, count(*) as n`);
  push("  from public.profiles p group by 1");
  push(") m");
  push("where a.email is null and not a.unassigned and m.name_key = a.name_key and m.n = 1;");
  push("");
  push("-- The old app's built-in \"admin\" login is the administrator: when no account");
  push("-- is called Admin, use the only active admin account.");
  push("update firebase_agents a set profile_id = (select p.id from public.profiles p where p.role = 'ADMIN' and p.is_active)");
  push("where a.profile_id is null and a.email is null and not a.unassigned and a.name_key = 'admin'");
  push("  and (select count(*) from public.profiles p where p.role = 'ADMIN' and p.is_active) = 1;");
  push("");
  push("do $$");
  push("declare problems text;");
  push("begin");
  push("  select string_agg(");
  push("    case");
  push("      when a.email is not null then format('%s (%s leads): no web account with email %s', a.display_name, a.lead_count, a.email)");
  push("      when a.name_key = 'admin' then format('%s: no account named Admin and not exactly one active admin account', a.display_name)");
  push(`      when (select count(*) from public.profiles p where ${SQL_NAME_KEY} = a.name_key) > 1`);
  push("        then format('%s (%s leads): several web accounts have this name', a.display_name, a.lead_count)");
  push("      else format('%s (%s leads): no web account with this full name', a.display_name, a.lead_count)");
  push("    end, '; ' order by a.lead_count desc)");
  push("  into problems");
  push("  from firebase_agents a");
  push("  where a.required and a.profile_id is null;");
  push("  if problems is not null then");
  push("    raise exception 'Agents without a web account: %', problems");
  push("      using hint = 'Create the account, then set its name: update public.profiles set full_name = ''<name>'' where email = ''<login email>''. Or map the name in agents.json (an email, or null for Unassigned) and regenerate.';");
  push("  end if;");
  push("end $$;");
  push("");

  push("create temporary table firebase_lead_map (legacy_id text primary key, lead_id bigint not null) on commit drop;");
  push("");
  push("-- Keep each lead's original assignment time instead of the import time, so");
  push("-- My Day does not list every imported lead as a new assignment. This is the");
  push("-- same backfill the agent workspace migration used for existing leads.");
  push("alter table public.leads disable trigger leads_track_assignment;");
  push("");

  for (const l of imported) {
    const agent = agentRef(l.agentKey);
    push(`-- legacy ${l.legacyId}`);
    push("with ins as (");
    push("  insert into public.leads (");
    push("    client_name, type, business_type, policy_product, sub_product_name, renewal_date,");
    push("    poc_name, poc_designation, poc_contact_number, poc_email_id,");
    push("    poc2_name, poc2_designation, poc2_contact_number, poc2_email_id,");
    push("    notes, status, assigned_agent_id, assigned_at, created_at");
    push("  ) values (");
    push(
      `    ${lit(l.clientName)}, ${lit(l.type)}, ${lit(l.businessType)}, ${lit(l.policyProduct)}, ${lit(l.subProductName)}, ${l.renewalDate ? `${lit(l.renewalDate)}::date` : "null"},`,
    );
    push(`    ${lit(l.pocName)}, ${lit(l.pocDesignation)}, ${lit(l.pocContactNumber)}, ${lit(l.pocEmailId)},`);
    push(`    ${lit(l.poc2Name)}, ${lit(l.poc2Designation)}, ${lit(l.poc2ContactNumber)}, ${lit(l.poc2EmailId)},`);
    push(`    ${lit(l.notes)}, ${lit(l.status)}, ${agent}, case when ${agent} is not null then ${ts(l.createdAt)} end, ${ts(l.createdAt)}`);
    push("  ) returning id");
    push(`) insert into firebase_lead_map select ${lit(l.legacyId)}, id from ins;`);
    for (const n of l.leadNotes) {
      push(
        `insert into public.lead_notes (lead_id, agent_id, agent_name, content, created_at) select lead_id, ${agentRef(n.agentKey)}, ${lit(n.agentName)}, ${lit(n.content)}, ${ts(n.createdAt)} from firebase_lead_map where legacy_id = ${lit(l.legacyId)};`,
      );
    }
    push("");
  }

  push("alter table public.leads enable trigger leads_track_assignment;");
  push("");
  push("-- The old app never closed its renewal-due entries, so every renewal date more");
  push("-- than 30 days past would open as an overdue task and bury today's work on My");
  push("-- Day. Close those; the lead keeps its renewal date, so overdue renewals still");
  push("-- show in analytics and on the lead.");
  push("update public.events e set is_completed = true");
  push("from firebase_lead_map m");
  push("where e.lead_id = m.lead_id and e.is_system_generated and e.milestone = 'DUE'");
  push("  and e.event_timestamp < now() - interval '30 days';");
  push("");

  if (notes) {
    push("-- Old notes were already seen in the old app; don't light up everyone's unread badge.");
    push("insert into public.lead_note_reads (note_id, user_id)");
    push("select n.id, p.id");
    push("from public.lead_notes n");
    push("join firebase_lead_map m on m.lead_id = n.lead_id");
    push("cross join public.profiles p");
    push("on conflict (note_id, user_id) do nothing;");
    push("");
  }

  for (const e of events) {
    const leadId = e.leadLegacyId
      ? `(select lead_id from firebase_lead_map where legacy_id = ${lit(e.leadLegacyId)})`
      : "null";
    push(
      `insert into public.events (lead_id, title, event_timestamp, notes, is_completed, assigned_agent_id, created_at) values (${leadId}, ${lit(e.title)}, ${lit(e.eventTimestamp)}::timestamptz, ${lit(e.notes)}, ${e.isCompleted}, ${agentRef(e.agentKey)}, ${ts(e.createdAt)});`,
    );
  }
  if (events.length) push("");

  const marker = {
    imported_at: "now",
    source: sourceLabel,
    generated_at: generatedAt,
    leads: imported.length,
    notes,
    events: events.length,
  };
  push("insert into public.app_settings (key, value, description) values (");
  push(
    `  'firebase_import', jsonb_set(${lit(JSON.stringify(marker))}::jsonb, '{imported_at}', to_jsonb(now())), 'Set by the one-time import from the old app''s Firebase database; blocks a second run'`,
  );
  push(");");
  push("");
  push("commit;");
  push("");
  push("select value from public.app_settings where key = 'firebase_import';");
  push("");
  return out.join("\n");
}

export function buildCheckSql(result, { generatedAt = new Date().toISOString() } = {}) {
  const { imported, agents } = result;
  const out = [];
  const push = (s) => out.push(s);
  push(`-- Read-only checks for the Firebase import (generated ${generatedAt}). Changes nothing.`);
  push("-- Run before import.sql: every row should say ok before you import.");
  push("");
  push("with agents (name_key, display_name, email, unassigned, required, lead_count) as (");
  push(
    agents.length
      ? `  values\n  ${agentValues(agents).join(",\n  ")}`
      : "  select null::text, null::text, null::text, false, false, 0 where false",
  );
  push("),");
  push("matches as (");
  push("  select a.*,");
  push("    (select count(*) from public.profiles p where a.email is not null and p.email = a.email) as by_email,");
  push(`    (select count(*) from public.profiles p where ${SQL_NAME_KEY} = a.name_key) as by_name,`);
  push("    (select count(*) from public.profiles p where a.name_key = 'admin' and p.role = 'ADMIN' and p.is_active) as admins,");
  push("    (select string_agg(p.full_name || ' <' || p.email || '>' || case when p.is_active then '' else ' (inactive)' end, ', ')");
  push(`       from public.profiles p where (a.email is not null and p.email = a.email) or (a.email is null and ${SQL_NAME_KEY} = a.name_key)) as accounts,`);
  push("    (select string_agg(p.full_name || ' <' || p.email || '>', ', ') from public.profiles p where p.role = 'ADMIN' and p.is_active) as admin_accounts");
  push("  from agents a",);
  push(")");
  push("select 1 as ord, 'Database migrations applied' as check_name,");
  push("  case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leads' and column_name = 'assigned_at')");
  push("        and exists (select 1 from pg_trigger where tgrelid = 'public.leads'::regclass and tgname = 'leads_track_assignment')");
  push("       then 'ok' else 'run npx supabase db push first' end as status,");
  push("  '' as detail");
  push("union all");
  push("select 2, 'Import status',");
  push("  case when exists (select 1 from public.app_settings where key = 'firebase_import') then 'already imported' else 'ok' end,");
  push("  coalesce((select 'Imported ' || (value ->> 'leads') || ' leads at ' || (value ->> 'imported_at') from public.app_settings where key = 'firebase_import'),");
  push(`    'Ready to import ${imported.length} leads')`);
  push("union all");
  push("select 3, 'Leads already in the web app',");
  push("  'ok',");
  push("  (select count(*) from public.leads)::text || ' (imported leads for the same companies will be flagged as duplicates)'");
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
  push("    else 'no web account with this full name'");
  push("  end,");
  push("  case");
  push("    when m.unassigned then 'imported as Unassigned (by choice)'");
  push("    when coalesce(m.accounts, '') <> '' and (m.by_email = 1 or (m.email is null and m.by_name = 1)) then 'maps to ' || m.accounts");
  push("    when m.email is null and m.by_name = 0 and m.admins = 1 then 'maps to the admin account ' || m.admin_accounts");
  push("    when not m.required then 'no account; their notes keep the name only'");
  push("    else coalesce('matches ' || m.accounts, 'create an account, then: update public.profiles set full_name = ''' || m.display_name || ''' where email = ''<their login email>''')");
  push("  end");
  push("from matches m");
  push("order by 1, 2;");
  push("");
  return out.join("\n");
}
