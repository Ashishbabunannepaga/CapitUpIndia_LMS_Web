-- CapitUpIndia LMS: AI and automation support.
--
--   * leads.address: company address (filled by visiting card OCR).
--   * Visiting card images: private storage bucket; a lead can only point at
--     a card its creator uploaded (or one an admin sets).
--   * notifications + deliver_due_reminders(): the server-side job that fires
--     renewal countdown reminders. Runs every minute from Inngest with the
--     service role; nothing depends on a browser staying open.
--   * next_round_robin_agents(): fair, persisted round-robin for bulk import.
--   * pipeline_analytics() / ai_usage_summary(): dashboard aggregates.
--     SECURITY INVOKER, so RLS decides which rows are counted.

-- ---------------------------------------------------------------------------
-- Address
-- ---------------------------------------------------------------------------

alter table public.leads
  add column address text not null default '' check (char_length(address) <= 1000);

-- ---------------------------------------------------------------------------
-- Visiting cards
-- ---------------------------------------------------------------------------

-- Cards are uploaded by the server (service role) under "<uploader id>/...".
-- No storage policies are created, so end users cannot read or list the
-- bucket directly; the app hands out short-lived signed URLs after checking
-- the user can see the lead.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('visiting-cards', 'visiting-cards', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end;
$$;

create or replace function public.leads_guard_card_path()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.visiting_card_path is not null
     and (tg_op = 'INSERT' or new.visiting_card_path is distinct from old.visiting_card_path)
     and not public.can_manage_all()
     and new.visiting_card_path not like (auth.uid()::text || '/%') then
    raise exception 'You can only attach visiting cards you uploaded' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger leads_guard_card_path
  before insert or update of visiting_card_path on public.leads
  for each row execute function public.leads_guard_card_path();

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('renewal_reminder', 'other')),
  title text not null check (char_length(title) between 1 and 300),
  body text not null default '' check (char_length(body) <= 2000),
  lead_id bigint references public.leads (id) on delete cascade,
  event_id bigint references public.events (id) on delete set null,
  milestone text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;

create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_active_user()));

create policy notifications_update on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.is_active_user()))
  with check (user_id = (select auth.uid()));

-- Users can only mark their own notifications read; the server writes them.
revoke all on public.notifications from anon;
revoke insert, update, delete, truncate on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Fires every background reminder that is due and not yet sent.
--   * Each reminder is marked sent exactly once (row locks + SKIP LOCKED, so
--     overlapping runs never double-send).
--   * One notification per lead per run: if several milestones are due at
--     once (say the job was down), only the latest one is announced.
--   * Goes to the assigned agent; unassigned leads, or leads whose agent is
--     inactive, go to every active admin.
--   * Closed leads (won or lost) are marked sent without a notification:
--     their renewal is no longer being chased, as on My Day.
-- Returns the number of notifications written.
create or replace function public.deliver_due_reminders(p_limit integer default 1000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivered integer;
begin
  with due as (
    select e.id
    from public.events e
    where e.is_background_reminder
      and e.reminder_sent_at is null
      and e.event_timestamp <= now()
    order by e.event_timestamp
    limit greatest(coalesce(p_limit, 1000), 1)
    for update skip locked
  ),
  marked as (
    update public.events e
       set reminder_sent_at = now()
      from due
     where e.id = due.id
    returning e.id, e.lead_id, e.milestone, e.event_timestamp, e.assigned_agent_id
  ),
  latest as (
    select distinct on (m.lead_id)
      m.id as event_id, m.lead_id, m.milestone, m.assigned_agent_id,
      l.client_name, l.policy_product, l.renewal_date, l.poc_name, l.poc_contact_number
    from marked m
    join public.leads l on l.id = m.lead_id
    where l.status not in ('Closed Won', 'Closed Lost') and l.renewal_date is not null
    order by m.lead_id, m.event_timestamp desc
  ),
  recipients as (
    select latest.*, p.id as user_id
    from latest
    join public.profiles p
      on p.is_active
     and (
       p.id = latest.assigned_agent_id
       or (
         p.role = 'ADMIN'
         and not exists (
           select 1 from public.profiles a where a.id = latest.assigned_agent_id and a.is_active
         )
       )
     )
  )
  insert into public.notifications (user_id, kind, title, body, lead_id, event_id, milestone)
  select
    r.user_id,
    'renewal_reminder',
    left(r.milestone || ': ' || r.client_name || ' renewal (' || r.policy_product::text || ')', 300),
    left(
      'Renews ' || to_char(r.renewal_date, 'DD Mon YYYY')
      || case when btrim(r.poc_name) <> '' or btrim(r.poc_contact_number) <> '' then
           '. Contact: ' || concat_ws(' ', nullif(btrim(r.poc_name), ''),
                                      '(' || nullif(btrim(r.poc_contact_number), '') || ')')
         else '' end
      || case when r.assigned_agent_id is null then '. This lead is unassigned.' else '' end,
      2000
    ),
    r.lead_id,
    r.event_id,
    r.milestone
  from recipients r;

  get diagnostics delivered = row_count;
  return delivered;
end;
$$;

revoke execute on function public.deliver_due_reminders(integer) from public, anon, authenticated;
grant execute on function public.deliver_due_reminders(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Round-robin assignment
-- ---------------------------------------------------------------------------

insert into public.app_settings (key, value, description, updated_by) values
  ('round_robin_cursor', '0', 'Position of the next agent in bulk-import round-robin (maintained by the database)', null),
  ('ai_hourly_limit_per_user', '200', 'Maximum Gemini calls a user can make per hour', null)
on conflict (key) do nothing;

-- Returns p_count agent ids in round-robin order over active AGENT profiles
-- (sorted by name), continuing where the previous import stopped. Empty when
-- there are no active agents. Admin only.
create or replace function public.next_round_robin_agents(p_count integer)
returns uuid[]
language plpgsql
set search_path = ''
as $$
declare
  agents uuid[];
  n integer;
  pos integer;
  result uuid[] := '{}';
begin
  if not public.can_manage_all() then
    raise exception 'Only admins can distribute leads' using errcode = '42501';
  end if;
  if coalesce(p_count, 0) < 1 then
    return result;
  end if;

  select array_agg(id order by full_name, id) into agents
  from public.profiles
  where role = 'AGENT' and is_active;
  n := coalesce(array_length(agents, 1), 0);
  if n = 0 then
    return result;
  end if;

  select coalesce((value #>> '{}')::integer, 0) into pos
  from public.app_settings where key = 'round_robin_cursor'
  for update;
  pos := coalesce(pos, 0) % n;

  for i in 0 .. p_count - 1 loop
    result := result || agents[((pos + i) % n) + 1];
  end loop;

  insert into public.app_settings (key, value, description)
  values ('round_robin_cursor', to_jsonb((pos + p_count) % n), 'Position of the next agent in bulk-import round-robin (maintained by the database)')
  on conflict (key) do update set value = excluded.value;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Analytics
-- ---------------------------------------------------------------------------

-- Pipeline, renewal and agent metrics over the leads the caller can see.
create or replace function public.pipeline_analytics()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with today as (
    select (now() at time zone coalesce(
      (select value #>> '{}' from public.app_settings where key = 'timezone'), 'Asia/Kolkata'))::date as d
  ),
  l as (
    select leads.*, leads.status in ('Closed Won', 'Closed Lost') as closed
    from public.leads
  )
  select jsonb_build_object(
    'today', (select d from today),
    'total', (select count(*) from l),
    'duplicates', (select count(*) from l where is_duplicate),
    'unassigned', (select count(*) from l where assigned_agent_id is null),
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from l group by status) s), '{}'),
    'by_product', coalesce((select jsonb_object_agg(policy_product, n) from (select policy_product, count(*) n from l group by policy_product) s), '{}'),
    'by_type', coalesce((select jsonb_object_agg(type, n) from (select type, count(*) n from l group by type) s), '{}'),
    'by_business', coalesce((select jsonb_object_agg(business_type, n) from (select business_type, count(*) n from l group by business_type) s), '{}'),
    'renewals', (
      select jsonb_build_object(
        'overdue', count(*) filter (where renewal_date < t.d),
        'today', count(*) filter (where renewal_date = t.d),
        'week', count(*) filter (where renewal_date between t.d and t.d + 7),
        'month', count(*) filter (where renewal_date between t.d and t.d + 30),
        'upcoming', count(*) filter (where renewal_date between t.d and t.d + 90)
      )
      from l, today t
      where not l.closed and l.renewal_date is not null
    ),
    'renewals_by_month', coalesce((
      select jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'count', (
        select count(*) from l
        where not l.closed and date_trunc('month', l.renewal_date::timestamp) = m
      )) order by m)
      from today t, generate_series(date_trunc('month', t.d::timestamp), date_trunc('month', t.d::timestamp) + interval '11 months', interval '1 month') m
    ), '[]'),
    'created_by_month', coalesce((
      select jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'count', (
        select count(*) from l where date_trunc('month', l.created_at at time zone 'Asia/Kolkata') = m
      )) order by m)
      from today t, generate_series(date_trunc('month', t.d::timestamp) - interval '5 months', date_trunc('month', t.d::timestamp), interval '1 month') m
    ), '[]'),
    'agents', coalesce((
      select jsonb_agg(row_to_json(a)::jsonb order by a.total desc, a.agent_name)
      from (
        select
          l.assigned_agent_id as agent_id,
          coalesce(p.full_name, 'Unassigned') as agent_name,
          count(*) as total,
          count(*) filter (where l.status = 'Prospect') as prospect,
          count(*) filter (where l.status = 'Quoted') as quoted,
          count(*) filter (where l.status = 'Active Client') as active_client,
          count(*) filter (where l.status = 'Follow-up') as follow_up,
          count(*) filter (where l.status = 'Closed Won') as won,
          count(*) filter (where l.status = 'Closed Lost') as lost,
          count(*) filter (where not l.closed and l.renewal_date < t.d) as overdue_renewals,
          count(*) filter (where not l.closed and l.renewal_date between t.d and t.d + 30) as renewals_30d
        from l
        cross join today t
        left join public.profiles p on p.id = l.assigned_agent_id
        group by l.assigned_agent_id, p.full_name
      ) a
    ), '[]')
  );
$$;

-- AI calls, tokens and INR cost between two instants (agents see their own).
create or replace function public.ai_usage_summary(p_from timestamptz, p_to timestamptz default now())
returns jsonb
language sql
stable
set search_path = ''
as $$
  with u as (
    select * from public.ai_usage_logs where created_at >= p_from and created_at < p_to
  )
  select jsonb_build_object(
    'calls', (select count(*) from u),
    'input_tokens', (select coalesce(sum(input_tokens), 0) from u),
    'output_tokens', (select coalesce(sum(output_tokens), 0) from u),
    'cost_inr', (select coalesce(sum(cost_inr), 0) from u),
    'by_agent', coalesce((
      select jsonb_agg(row_to_json(a)::jsonb order by a.cost_inr desc)
      from (
        select user_id, agent_name, count(*) as calls,
               sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, sum(cost_inr) as cost_inr
        from u group by user_id, agent_name
      ) a
    ), '[]'),
    'by_feature', coalesce((
      select jsonb_agg(row_to_json(f)::jsonb order by f.cost_inr desc)
      from (
        select feature_name, count(*) as calls,
               sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, sum(cost_inr) as cost_inr
        from u group by feature_name
      ) f
    ), '[]'),
    'by_model', coalesce((
      select jsonb_agg(row_to_json(m)::jsonb order by m.cost_inr desc)
      from (
        select model_name, count(*) as calls,
               sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, sum(cost_inr) as cost_inr
        from u group by model_name
      ) m
    ), '[]'),
    'by_day', coalesce((
      select jsonb_agg(row_to_json(d)::jsonb order by d.day)
      from (
        select to_char((created_at at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as day,
               count(*) as calls, sum(cost_inr) as cost_inr
        from u group by 1
      ) d
    ), '[]')
  );
$$;

-- Pricing for the visiting-card model used first by the existing app.
-- Admins should confirm all prices against Google's current price list.
insert into public.ai_model_pricing (model_name, display_name, input_usd_per_million, output_usd_per_million, updated_by)
values ('gemini-3.1-pro-preview', 'Gemini 3.1 Pro (preview)', 2.00, 12.00, null)
on conflict (model_name) do nothing;

revoke execute on function
  public.leads_guard_card_path(),
  public.next_round_robin_agents(integer),
  public.pipeline_analytics(),
  public.ai_usage_summary(timestamptz, timestamptz)
from public, anon;

grant execute on function
  public.next_round_robin_agents(integer),
  public.pipeline_analytics(),
  public.ai_usage_summary(timestamptz, timestamptz)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime: the notification bell updates live (RLS applies).
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;
