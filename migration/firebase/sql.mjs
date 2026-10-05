// Turns the transform result into one SQL script that loads everything in a
// single transaction. It runs as the database owner (psql or the Supabase SQL
// editor), which the guard triggers treat as a privileged session, so original
// created_at timestamps are kept while duplicate flags and renewal reminders
// are still computed by the database itself.

const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/\u0000/g, "").replaceAll("'", "''")}'`);
const ts = (v) => (v ? `${lit(v)}::timestamptz` : "now()");
const profileId = (email) => (email ? `(select id from public.profiles where email = ${lit(email)})` : "null");

export function buildImportSql(result, { sourceLabel = "firebase export", generatedAt = new Date().toISOString() } = {}) {
  const { imported, events, agents } = result;
  const emails = [...new Set(agents.map((a) => a.email).filter(Boolean))].sort();
  const out = [];
  const push = (s) => out.push(s);

  push(`-- Firebase -> Supabase import, generated ${generatedAt} from ${sourceLabel}.`);
  push(`-- ${imported.length} leads, ${imported.reduce((n, l) => n + l.leadNotes.length, 0)} notes, ${events.length} calendar events.`);
  push("-- Run as the database owner in one transaction, e.g.:");
  push("--   psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f import.sql");
  push("-- It refuses to run twice and refuses to run until every mapped agent has an account.");
  push("");
  push("begin;");
  push("");
  push("do $$");
  push("begin");
  push("  if exists (select 1 from public.app_settings where key = 'firebase_import') then");
  push("    raise exception 'The Firebase data has already been imported (app_settings.firebase_import)';");
  push("  end if;");
  push("end $$;");
  push("");

  if (emails.length) {
    push("do $$");
    push("declare missing text;");
    push("begin");
    push("  select string_agg(e, ', ') into missing");
    push(`  from unnest(array[${emails.map(lit).join(", ")}]::text[]) as e`);
    push("  where not exists (select 1 from public.profiles p where p.email = e);");
    push("  if missing is not null then");
    push("    raise exception 'Create these agent accounts before importing: %', missing;");
    push("  end if;");
    push("end $$;");
    push("");
  }

  push("create temporary table firebase_lead_map (legacy_id text primary key, lead_id bigint not null) on commit drop;");
  push("");

  for (const l of imported) {
    push(`-- legacy ${l.legacyId}`);
    push("with ins as (");
    push("  insert into public.leads (");
    push("    client_name, type, business_type, policy_product, sub_product_name, renewal_date,");
    push("    poc_name, poc_designation, poc_contact_number, poc_email_id,");
    push("    poc2_name, poc2_designation, poc2_contact_number, poc2_email_id,");
    push("    notes, status, assigned_agent_id, created_at");
    push("  ) values (");
    push(
      `    ${lit(l.clientName)}, ${lit(l.type)}, ${lit(l.businessType)}, ${lit(l.policyProduct)}, ${lit(l.subProductName)}, ${l.renewalDate ? `${lit(l.renewalDate)}::date` : "null"},`,
    );
    push(`    ${lit(l.pocName)}, ${lit(l.pocDesignation)}, ${lit(l.pocContactNumber)}, ${lit(l.pocEmailId)},`);
    push(`    ${lit(l.poc2Name)}, ${lit(l.poc2Designation)}, ${lit(l.poc2ContactNumber)}, ${lit(l.poc2EmailId)},`);
    push(`    ${lit(l.notes)}, ${lit(l.status)}, ${profileId(l.agentEmail)}, ${ts(l.createdAt)}`);
    push("  ) returning id");
    push(`) insert into firebase_lead_map select ${lit(l.legacyId)}, id from ins;`);
    for (const n of l.leadNotes) {
      push(
        `insert into public.lead_notes (lead_id, agent_id, agent_name, content, created_at) select lead_id, ${profileId(n.agentEmail)}, ${lit(n.agentName)}, ${lit(n.content)}, ${ts(n.createdAt)} from firebase_lead_map where legacy_id = ${lit(l.legacyId)};`,
      );
    }
    push("");
  }

  for (const e of events) {
    const leadId = e.leadLegacyId
      ? `(select lead_id from firebase_lead_map where legacy_id = ${lit(e.leadLegacyId)})`
      : "null";
    push(
      `insert into public.events (lead_id, title, event_timestamp, notes, is_completed, assigned_agent_id, created_at) values (${leadId}, ${lit(e.title)}, ${lit(e.eventTimestamp)}::timestamptz, ${lit(e.notes)}, ${e.isCompleted}, ${profileId(e.agentEmail)}, ${ts(e.createdAt)});`,
    );
  }
  if (events.length) push("");

  const marker = {
    imported_at: "now",
    source: sourceLabel,
    generated_at: generatedAt,
    leads: imported.length,
    notes: imported.reduce((n, l) => n + l.leadNotes.length, 0),
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
  return out.join("\n");
}
