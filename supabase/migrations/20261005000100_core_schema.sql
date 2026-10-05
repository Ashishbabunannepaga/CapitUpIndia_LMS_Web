-- CapitUpIndia LMS: core schema.
-- Entities: profiles (users + roles), leads, events, lead_notes, lead_note_reads,
-- ai_usage_logs, ai_model_pricing, app_settings, audit_logs.
-- Field names follow the existing app's data model (see the system spec, section 4.2).

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.user_role as enum ('ADMIN', 'AGENT');

create type public.lead_type as enum ('New', 'Renewal');

create type public.business_type as enum ('Corporate', 'Retail');

create type public.policy_product as enum (
  'Health', 'Fire or Property', 'Life', 'Motor', 'Liability', 'Travel', 'Marine', 'Credit'
);

create type public.lead_status as enum (
  'Prospect', 'Quoted', 'Active Client', 'Follow-up', 'Closed Won', 'Closed Lost'
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Canonical company name used for duplicate detection.
-- Lowercases, turns '&' into 'and', strips punctuation and legal suffixes
-- (Pvt, Private, Ltd, Limited, LLP, Inc, ...) and collapses whitespace, so
-- "Renee Systems Pvt. Ltd." and "renee systems" normalize to the same value.
create or replace function public.normalize_company_name(name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    nullif(
      btrim(regexp_replace(
        regexp_replace(
          regexp_replace(replace(lower(coalesce(name, '')), '&', ' and '), '[^a-z0-9]+', ' ', 'g'),
          '\m(pvt|private|ltd|limited|llp|llc|inc|incorporated|corp|corporation|plc)\M', ' ', 'g'
        ),
        '\s+', ' ', 'g'
      )),
      ''
    ),
    btrim(lower(coalesce(name, '')))
  );
$$;

-- ---------------------------------------------------------------------------
-- Users / profiles
-- ---------------------------------------------------------------------------

-- One row per Supabase Auth user. This is the spec's "Users" entity.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 120),
  role public.user_role not null default 'AGENT',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_role_active_idx on public.profiles (role, is_active);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Every new auth user gets an AGENT profile. The role is never taken from
-- user-supplied signup metadata; promoting to ADMIN is an admin action.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------

create table public.leads (
  id bigint generated always as identity primary key,
  client_name text not null check (char_length(btrim(client_name)) between 1 and 300),
  client_name_normalized text generated always as (public.normalize_company_name(client_name)) stored,
  type public.lead_type not null default 'New',
  business_type public.business_type not null default 'Corporate',
  policy_product public.policy_product not null default 'Health',
  sub_product_name text not null default '' check (char_length(sub_product_name) <= 200),
  renewal_date date,

  poc_name text not null default '' check (char_length(poc_name) <= 120),
  poc_designation text not null default 'poc' check (char_length(poc_designation) <= 120),
  poc_contact_number text not null default '' check (char_length(poc_contact_number) <= 32),
  poc_email_id text not null default '' check (poc_email_id = '' or poc_email_id ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  poc2_name text not null default '' check (char_length(poc2_name) <= 120),
  poc2_designation text not null default '' check (char_length(poc2_designation) <= 120),
  poc2_contact_number text not null default '' check (char_length(poc2_contact_number) <= 32),
  poc2_email_id text not null default '' check (poc2_email_id = '' or poc2_email_id ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),

  -- Free-form notes captured with the lead (AI intake, imports, extra contacts).
  -- The collaborative timestamped thread lives in lead_notes.
  notes text not null default '' check (char_length(notes) <= 20000),
  status public.lead_status not null default 'Prospect',
  assigned_agent_id uuid references public.profiles (id) on delete set null,

  -- Duplicate state is computed by the database (see leads_before_write) and
  -- can only be cleared by an admin.
  is_duplicate boolean not null default false,
  duplicate_label text not null default '',
  duplicate_resolved_at timestamptz,
  duplicate_resolved_by uuid references public.profiles (id) on delete set null,

  visiting_card_path text,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index leads_client_name_normalized_idx on public.leads (client_name_normalized);
create index leads_client_name_trgm_idx on public.leads using gin (client_name_normalized extensions.gin_trgm_ops);
create index leads_renewal_date_idx on public.leads (renewal_date) where renewal_date is not null;
create index leads_assigned_status_idx on public.leads (assigned_agent_id, status);
create index leads_status_idx on public.leads (status);
create index leads_created_at_idx on public.leads (created_at desc);
create index leads_duplicate_idx on public.leads (is_duplicate) where is_duplicate;

create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Events: visible calendar events and background countdown reminders
-- ---------------------------------------------------------------------------

create table public.events (
  id bigint generated always as identity primary key,
  lead_id bigint references public.leads (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  event_timestamp timestamptz not null,
  notes text not null default '' check (char_length(notes) <= 5000),
  -- 'DUE' for the visible renewal event, 'T-30 Days' ... 'T-5 Minutes' for
  -- background reminders, null for user-created events.
  milestone text,
  is_completed boolean not null default false,
  completed_at timestamptz,
  is_system_generated boolean not null default false,
  is_background_reminder boolean not null default false,
  -- Set by the reminder dispatcher once a background reminder is delivered.
  reminder_sent_at timestamptz,
  assigned_agent_id uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_system_milestone check (not is_system_generated or (lead_id is not null and milestone is not null))
);

create unique index events_lead_milestone_key on public.events (lead_id, milestone) where is_system_generated;
create index events_agent_time_idx on public.events (assigned_agent_id, event_timestamp);
create index events_lead_idx on public.events (lead_id);
create index events_pending_reminders_idx on public.events (event_timestamp)
  where is_background_reminder and reminder_sent_at is null;

create trigger events_set_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Lead notes (append-only collaboration thread)
-- Rendered as "[Agent Name - DD MMM YYYY, HH:mm]: Note".
-- ---------------------------------------------------------------------------

create table public.lead_notes (
  id bigint generated always as identity primary key,
  lead_id bigint not null references public.leads (id) on delete cascade,
  agent_id uuid references public.profiles (id) on delete set null default auth.uid(),
  agent_name text not null,
  content text not null check (char_length(btrim(content)) between 1 and 5000),
  created_at timestamptz not null default now()
);

create index lead_notes_lead_idx on public.lead_notes (lead_id, created_at desc);
create index lead_notes_created_idx on public.lead_notes (created_at desc);

-- Per-user read receipts, used for the admin "new notes" badge.
create table public.lead_note_reads (
  note_id bigint not null references public.lead_notes (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  read_at timestamptz not null default now(),
  primary key (note_id, user_id)
);

create index lead_note_reads_user_idx on public.lead_note_reads (user_id);

-- ---------------------------------------------------------------------------
-- AI usage and cost accounting
-- ---------------------------------------------------------------------------

-- Central, admin-editable pricing per model (USD per 1M tokens).
create table public.ai_model_pricing (
  model_name text primary key,
  display_name text not null,
  input_usd_per_million numeric(10, 4) not null check (input_usd_per_million >= 0),
  output_usd_per_million numeric(10, 4) not null check (output_usd_per_million >= 0),
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null default auth.uid()
);

create trigger ai_model_pricing_set_updated_at
  before update on public.ai_model_pricing
  for each row execute function public.set_updated_at();

-- Key/value configuration (FX rate, renewal due time, timezone, ...).
create table public.app_settings (
  key text primary key,
  value jsonb not null,
  description text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null default auth.uid()
);

create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- Rates carried over from the existing app; admins can change them.
insert into public.app_settings (key, value, description) values
  ('usd_to_inr', '83.50', 'Exchange rate used to convert Gemini USD pricing to INR'),
  ('renewal_due_time', '"10:00"', 'Local time of day a policy is treated as due on its renewal date (HH:MM)'),
  ('timezone', '"Asia/Kolkata"', 'Business timezone for renewal dates and reminders');

insert into public.ai_model_pricing (model_name, display_name, input_usd_per_million, output_usd_per_million, updated_by) values
  ('gemini-3.5-flash', 'Gemini 3.5 Flash', 0.075, 0.30, null),
  ('gemini-2.5-flash', 'Gemini 2.5 Flash', 0.075, 0.30, null),
  ('gemini-2.5-pro', 'Gemini 2.5 Pro', 1.25, 5.00, null);

create table public.ai_usage_logs (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles (id) on delete set null,
  agent_name text not null,
  feature_name text not null check (feature_name in (
    'lead_intake', 'card_ocr', 'follow_up', 'follow_up_rephrase', 'bulk_mapping', 'other'
  )),
  model_name text not null,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  cost_inr numeric(12, 4) not null check (cost_inr >= 0),
  created_at timestamptz not null default now()
);

create index ai_usage_logs_user_idx on public.ai_usage_logs (user_id, created_at desc);
create index ai_usage_logs_feature_idx on public.ai_usage_logs (feature_name, created_at desc);
create index ai_usage_logs_created_idx on public.ai_usage_logs (created_at desc);

-- Cost is always computed from central pricing, never trusted from the caller.
create or replace function public.ai_usage_logs_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  pricing public.ai_model_pricing;
  fx numeric;
begin
  select * into pricing from public.ai_model_pricing where model_name = new.model_name;
  if not found then
    raise exception 'No pricing configured for model %', new.model_name using errcode = '23503';
  end if;
  select (value #>> '{}')::numeric into fx from public.app_settings where key = 'usd_to_inr';

  new.cost_inr := round(
    ((new.input_tokens * pricing.input_usd_per_million + new.output_tokens * pricing.output_usd_per_million) / 1000000.0)
      * coalesce(fx, 0),
    4
  );
  if new.agent_name is null or new.agent_name = '' then
    select full_name into new.agent_name from public.profiles where id = new.user_id;
    new.agent_name := coalesce(new.agent_name, 'System');
  end if;
  new.created_at := now();
  return new;
end;
$$;

create trigger ai_usage_logs_before_insert
  before insert on public.ai_usage_logs
  for each row execute function public.ai_usage_logs_before_insert();

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

create table public.audit_logs (
  id bigint generated always as identity primary key,
  table_name text not null,
  record_id text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  actor_id uuid,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_record_idx on public.audit_logs (table_name, record_id, created_at desc);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_json jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_json jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
begin
  -- Skip no-op updates (e.g. only updated_at changed).
  if tg_op = 'UPDATE' and (old_json - 'updated_at') = (new_json - 'updated_at') then
    return null;
  end if;

  insert into public.audit_logs (table_name, record_id, action, actor_id, old_data, new_data)
  values (
    tg_table_name,
    coalesce(
      new_json ->> 'id', old_json ->> 'id',
      new_json ->> 'key', old_json ->> 'key',
      new_json ->> 'model_name', old_json ->> 'model_name'
    ),
    tg_op, auth.uid(), old_json, new_json
  );
  return null;
end;
$$;

create trigger leads_audit
  after insert or update or delete on public.leads
  for each row execute function public.write_audit_log();

create trigger profiles_audit
  after update or delete on public.profiles
  for each row execute function public.write_audit_log();

create trigger lead_notes_audit
  after delete on public.lead_notes
  for each row execute function public.write_audit_log();

create trigger ai_model_pricing_audit
  after insert or update or delete on public.ai_model_pricing
  for each row execute function public.write_audit_log();

create trigger app_settings_audit
  after insert or update or delete on public.app_settings
  for each row execute function public.write_audit_log();
