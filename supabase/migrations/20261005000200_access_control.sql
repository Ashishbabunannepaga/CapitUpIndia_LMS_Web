-- CapitUpIndia LMS: roles, server-side guards, duplicate detection and RLS.
--
-- Access model
--   ADMIN  sees and manages everything.
--   AGENT  sees only leads assigned to them (plus their events and the notes on
--          those leads), can create leads only for themselves, and cannot
--          reassign, delete, or change duplicate state.
--   Inactive users see nothing.
--   service_role (server-only key) bypasses RLS for jobs such as AI usage
--   logging, reminders and bulk import.

-- ---------------------------------------------------------------------------
-- Role helpers. SECURITY DEFINER so policies can read profiles without
-- recursing into profiles' own RLS.
-- ---------------------------------------------------------------------------

create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = auth.uid() and is_active;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_role() = 'ADMIN', false);
$$;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_role() is not null;
$$;

-- True for the migration owner, the dashboard and the service_role key, i.e.
-- anything that is not an end user's API session. Must stay SECURITY INVOKER.
create or replace function public.is_privileged_session()
returns boolean
language sql
stable
set search_path = ''
as $$
  select current_user not in ('authenticated', 'anon');
$$;

create or replace function public.can_manage_all()
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.is_privileged_session() or public.is_admin();
$$;

-- ---------------------------------------------------------------------------
-- Duplicate detection
-- ---------------------------------------------------------------------------

-- Exact match on the normalized company name, across all agents. Used by the
-- leads trigger to set is_duplicate / duplicate_label deterministically.
create or replace function public.lead_duplicate_state(p_client_name text, p_exclude_id bigint default null)
returns table (is_duplicate boolean, duplicate_label text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    count(*) > 0,
    case when count(*) > 0 then
      'Duplicate: Already being processed by agent(s) ['
        || string_agg(distinct coalesce(p.full_name, 'Unassigned'), ', ')
        || ']'
    else '' end
  from public.leads l
  left join public.profiles p on p.id = l.assigned_agent_id
  where l.client_name_normalized = public.normalize_company_name(p_client_name)
    and l.id <> coalesce(p_exclude_id, -1);
$$;

-- Fuzzy company lookup (pg_trgm) for warnings before a lead is created or
-- imported, e.g. "Renee Systems India Pvt Ltd" finds "Renee Systems".
-- Agents get the matching company and its owner even when it is not theirs,
-- and nothing else about the record.
create or replace function public.find_similar_leads(
  p_client_name text,
  p_exclude_id bigint default null,
  p_threshold real default 0.45,
  p_limit integer default 5
)
returns table (
  lead_id bigint,
  client_name text,
  assigned_agent_id uuid,
  assigned_agent_name text,
  similarity real,
  is_exact boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  q text := public.normalize_company_name(p_client_name);
begin
  if not public.is_active_user() and not public.is_privileged_session() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if q = '' then
    return;
  end if;

  perform set_config('pg_trgm.similarity_threshold', p_threshold::text, true);
  perform set_config('pg_trgm.word_similarity_threshold', greatest(p_threshold, 0.6)::text, true);

  return query
    select
      l.id,
      l.client_name,
      l.assigned_agent_id,
      coalesce(p.full_name, 'Unassigned'),
      greatest(
        extensions.similarity(l.client_name_normalized, q),
        extensions.word_similarity(q, l.client_name_normalized),
        extensions.word_similarity(l.client_name_normalized, q)
      ) as score,
      l.client_name_normalized = q
    from public.leads l
    left join public.profiles p on p.id = l.assigned_agent_id
    where l.id <> coalesce(p_exclude_id, -1)
      and (
        l.client_name_normalized operator(extensions.%) q
        or q operator(extensions.<%) l.client_name_normalized
        or l.client_name_normalized operator(extensions.<%) q
      )
    order by (l.client_name_normalized = q) desc, score desc, l.id
    limit least(greatest(p_limit, 1), 50);
end;
$$;

-- ---------------------------------------------------------------------------
-- Guard triggers (SECURITY INVOKER so they see the caller's role)
-- ---------------------------------------------------------------------------

create or replace function public.profiles_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.can_manage_all() then
    if new.id <> old.id or new.email <> old.email or new.role <> old.role
       or new.is_active <> old.is_active or new.created_at <> old.created_at then
      raise exception 'Only admins can change role, status or email' using errcode = '42501';
    end if;
  end if;

  -- Never leave the system without an active admin.
  if old.role = 'ADMIN' and old.is_active and (new.role <> 'ADMIN' or not new.is_active) then
    if not exists (
      select 1 from public.profiles
      where role = 'ADMIN' and is_active and id <> old.id
    ) then
      raise exception 'Cannot remove the last active admin' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_before_update
  before update on public.profiles
  for each row execute function public.profiles_before_update();

create or replace function public.leads_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  manager boolean := public.can_manage_all();
  dup record;
begin
  new.client_name := btrim(new.client_name);
  new.poc_email_id := lower(btrim(new.poc_email_id));
  new.poc2_email_id := lower(btrim(new.poc2_email_id));
  new.poc_designation := coalesce(nullif(btrim(new.poc_designation), ''), 'poc');

  if tg_op = 'INSERT' then
    if not public.is_privileged_session() then
      new.created_by := auth.uid();
      new.created_at := now();
    end if;
    new.duplicate_resolved_at := null;
    new.duplicate_resolved_by := null;
  else
    if not manager and (
      new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
      or new.is_duplicate is distinct from old.is_duplicate
      or new.duplicate_label is distinct from old.duplicate_label
      or new.duplicate_resolved_at is distinct from old.duplicate_resolved_at
      or new.duplicate_resolved_by is distinct from old.duplicate_resolved_by
    ) then
      raise exception 'Only admins can change ownership or duplicate state' using errcode = '42501';
    end if;

    -- Admin resolves a duplicate by clearing the flag.
    if old.is_duplicate and not new.is_duplicate then
      new.duplicate_label := '';
      new.duplicate_resolved_at := now();
      new.duplicate_resolved_by := auth.uid();
    end if;
  end if;

  if tg_op = 'INSERT'
     or public.normalize_company_name(new.client_name) <> public.normalize_company_name(old.client_name) then
    select * into dup from public.lead_duplicate_state(new.client_name, new.id);
    new.is_duplicate := dup.is_duplicate;
    new.duplicate_label := dup.duplicate_label;
    new.duplicate_resolved_at := null;
    new.duplicate_resolved_by := null;
  end if;

  return new;
end;
$$;

create trigger leads_before_write
  before insert or update on public.leads
  for each row execute function public.leads_before_write();

create or replace function public.events_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not public.can_manage_all() then
      if new.is_system_generated or new.is_background_reminder or new.milestone is not null
         or new.reminder_sent_at is not null then
        raise exception 'System reminders are created by the server' using errcode = '42501';
      end if;
      new.created_by := auth.uid();
      new.created_at := now();
    end if;
  else
    if not public.can_manage_all() then
      if new.is_system_generated <> old.is_system_generated
         or new.is_background_reminder <> old.is_background_reminder
         or new.milestone is distinct from old.milestone
         or new.reminder_sent_at is distinct from old.reminder_sent_at
         or new.created_by is distinct from old.created_by
         or new.created_at <> old.created_at then
        raise exception 'Not allowed to change reminder fields' using errcode = '42501';
      end if;
      if old.is_system_generated and (
        new.title <> old.title
        or new.event_timestamp <> old.event_timestamp
        or new.lead_id is distinct from old.lead_id
      ) then
        raise exception 'Renewal milestones follow the lead''s renewal date' using errcode = '42501';
      end if;
    end if;
  end if;

  if new.is_completed and new.completed_at is null then
    new.completed_at := now();
  elsif not new.is_completed then
    new.completed_at := null;
  end if;
  return new;
end;
$$;

create trigger events_before_write
  before insert or update on public.events
  for each row execute function public.events_before_write();

create or replace function public.lead_notes_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_privileged_session() then
    new.agent_id := auth.uid();
    new.created_at := now();
  end if;
  new.content := btrim(new.content);
  new.agent_name := coalesce(
    (select full_name from public.profiles where id = new.agent_id),
    nullif(btrim(new.agent_name), ''),
    'System'
  );
  return new;
end;
$$;

create trigger lead_notes_before_insert
  before insert on public.lead_notes
  for each row execute function public.lead_notes_before_insert();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.leads enable row level security;
alter table public.events enable row level security;
alter table public.lead_notes enable row level security;
alter table public.lead_note_reads enable row level security;
alter table public.ai_model_pricing enable row level security;
alter table public.app_settings enable row level security;
alter table public.ai_usage_logs enable row level security;
alter table public.audit_logs enable row level security;

-- profiles: active users can see the team (names for assignment and
-- duplicate warnings); users edit their own name; admins manage everyone.
create policy profiles_select on public.profiles
  for select to authenticated
  using ((select public.is_active_user()));

create policy profiles_update on public.profiles
  for update to authenticated
  using ((select public.is_admin()) or (id = (select auth.uid()) and (select public.is_active_user())))
  with check ((select public.is_admin()) or id = (select auth.uid()));

-- leads
create policy leads_select on public.leads
  for select to authenticated
  using (
    (select public.is_admin())
    or (assigned_agent_id = (select auth.uid()) and (select public.is_active_user()))
  );

create policy leads_insert on public.leads
  for insert to authenticated
  with check (
    (select public.is_admin())
    or (assigned_agent_id = (select auth.uid()) and (select public.is_active_user()))
  );

create policy leads_update on public.leads
  for update to authenticated
  using (
    (select public.is_admin())
    or (assigned_agent_id = (select auth.uid()) and (select public.is_active_user()))
  )
  with check (
    (select public.is_admin())
    or assigned_agent_id = (select auth.uid())
  );

create policy leads_delete on public.leads
  for delete to authenticated
  using ((select public.is_admin()));

-- events
create policy events_select on public.events
  for select to authenticated
  using (
    (select public.is_admin())
    or (assigned_agent_id = (select auth.uid()) and (select public.is_active_user()))
  );

create policy events_insert on public.events
  for insert to authenticated
  with check (
    (select public.is_admin())
    or (
      assigned_agent_id = (select auth.uid())
      and (select public.is_active_user())
      and (lead_id is null or exists (select 1 from public.leads l where l.id = lead_id))
    )
  );

create policy events_update on public.events
  for update to authenticated
  using (
    (select public.is_admin())
    or (assigned_agent_id = (select auth.uid()) and (select public.is_active_user()))
  )
  with check (
    (select public.is_admin())
    or assigned_agent_id = (select auth.uid())
  );

create policy events_delete on public.events
  for delete to authenticated
  using (
    (select public.is_admin())
    or (assigned_agent_id = (select auth.uid()) and not is_system_generated and (select public.is_active_user()))
  );

-- lead_notes: visible with the lead; append-only for agents.
create policy lead_notes_select on public.lead_notes
  for select to authenticated
  using (
    (select public.is_admin())
    or exists (select 1 from public.leads l where l.id = lead_id)
  );

create policy lead_notes_insert on public.lead_notes
  for insert to authenticated
  with check (
    (select public.is_active_user())
    and agent_id = (select auth.uid())
    and exists (select 1 from public.leads l where l.id = lead_id)
  );

create policy lead_notes_delete on public.lead_notes
  for delete to authenticated
  using ((select public.is_admin()));

-- lead_note_reads: each user manages their own receipts.
create policy lead_note_reads_select on public.lead_note_reads
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy lead_note_reads_insert on public.lead_note_reads
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.lead_notes n where n.id = note_id)
  );

create policy lead_note_reads_delete on public.lead_note_reads
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- Pricing and settings: readable by the team, editable by admins.
create policy ai_model_pricing_select on public.ai_model_pricing
  for select to authenticated using ((select public.is_active_user()));
create policy ai_model_pricing_admin on public.ai_model_pricing
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy app_settings_select on public.app_settings
  for select to authenticated using ((select public.is_active_user()));
create policy app_settings_admin on public.app_settings
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- AI usage: written only by the server (service_role); agents read their own.
create policy ai_usage_logs_select on public.ai_usage_logs
  for select to authenticated
  using (
    (select public.is_admin())
    or (user_id = (select auth.uid()) and (select public.is_active_user()))
  );

-- Audit log: admins only, read-only.
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Privileges: nothing for anonymous users; no direct writes to logs.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from public, anon;

revoke insert, update, delete, truncate on public.ai_usage_logs from authenticated;
revoke insert, update, delete, truncate on public.audit_logs from authenticated;
revoke truncate on all tables in schema public from authenticated;
revoke insert, delete on public.profiles from authenticated;

grant execute on function
  public.normalize_company_name(text),
  public.current_user_role(),
  public.is_admin(),
  public.is_active_user(),
  public.is_privileged_session(),
  public.can_manage_all(),
  public.lead_duplicate_state(text, bigint),
  public.find_similar_leads(text, bigint, real, integer)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime (Supabase): stream lead, event and note changes; RLS still applies.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.leads, public.events, public.lead_notes;
  end if;
end;
$$;
