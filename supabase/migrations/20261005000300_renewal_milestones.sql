-- CapitUpIndia LMS: renewal countdown milestones.
--
-- Whenever a lead's renewal date is set or changed, the database writes:
--   * one visible calendar event ("DUE") at the renewal due time, and
--   * background reminders at T-30 Days, T-10 Days, T-5 Days, T-3 Days,
--     T-24 Hours, T-10 Hours, T-1 Hour, T-30 Minutes and T-5 Minutes.
-- Reminders already in the past are skipped. A background job delivers
-- pending reminders (is_background_reminder and reminder_sent_at is null),
-- so nothing depends on a browser staying open.

create table public.renewal_milestone_offsets (
  milestone text primary key,
  offset_interval interval not null,
  sort_order smallint not null unique
);

insert into public.renewal_milestone_offsets (milestone, offset_interval, sort_order) values
  ('T-30 Days', interval '30 days', 1),
  ('T-10 Days', interval '10 days', 2),
  ('T-5 Days', interval '5 days', 3),
  ('T-3 Days', interval '3 days', 4),
  ('T-24 Hours', interval '24 hours', 5),
  ('T-10 Hours', interval '10 hours', 6),
  ('T-1 Hour', interval '1 hour', 7),
  ('T-30 Minutes', interval '30 minutes', 8),
  ('T-5 Minutes', interval '5 minutes', 9);

alter table public.renewal_milestone_offsets enable row level security;
create policy renewal_milestone_offsets_select on public.renewal_milestone_offsets
  for select to authenticated using ((select public.is_active_user()));
revoke all on public.renewal_milestone_offsets from anon;
revoke insert, update, delete, truncate on public.renewal_milestone_offsets from authenticated;

-- The moment a policy is due: renewal date at the configured local time.
create or replace function public.renewal_due_at(p_renewal_date date)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select (
    p_renewal_date
    + coalesce((select (value #>> '{}')::time from public.app_settings where key = 'renewal_due_time'), time '10:00')
  ) at time zone coalesce((select value #>> '{}' from public.app_settings where key = 'timezone'), 'Asia/Kolkata');
$$;

create or replace function public.renewal_event_title(p_milestone text, p_client_name text, p_product public.policy_product)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_milestone = 'DUE' then 'Renewal due: ' || p_client_name || ' (' || p_product::text || ')'
    else p_milestone || ' renewal reminder: ' || p_client_name || ' (' || p_product::text || ')'
  end;
$$;

create or replace function public.sync_lead_milestones()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  due timestamptz;
begin
  if tg_op = 'INSERT' or new.renewal_date is distinct from old.renewal_date then
    delete from public.events where lead_id = new.id and is_system_generated;

    if new.renewal_date is not null then
      due := public.renewal_due_at(new.renewal_date);

      insert into public.events (
        lead_id, title, event_timestamp, milestone,
        is_system_generated, is_background_reminder, assigned_agent_id, created_by
      )
      select new.id, public.renewal_event_title('DUE', new.client_name, new.policy_product), due, 'DUE',
             true, false, new.assigned_agent_id, null::uuid
      union all
      select new.id, public.renewal_event_title(o.milestone, new.client_name, new.policy_product),
             due - o.offset_interval, o.milestone,
             true, true, new.assigned_agent_id, null::uuid
      from public.renewal_milestone_offsets o
      where due - o.offset_interval > now();
    end if;
    return null;
  end if;

  if new.assigned_agent_id is distinct from old.assigned_agent_id then
    update public.events
       set assigned_agent_id = new.assigned_agent_id
     where lead_id = new.id and is_system_generated;
  end if;

  if new.client_name <> old.client_name or new.policy_product <> old.policy_product then
    update public.events
       set title = public.renewal_event_title(milestone, new.client_name, new.policy_product)
     where lead_id = new.id and is_system_generated;
  end if;

  return null;
end;
$$;

create trigger leads_sync_milestones
  after insert or update of renewal_date, assigned_agent_id, client_name, policy_product on public.leads
  for each row execute function public.sync_lead_milestones();

revoke execute on function public.renewal_due_at(date) from public, anon;
revoke execute on function public.renewal_event_title(text, text, public.policy_product) from public, anon;
revoke execute on function public.sync_lead_milestones() from public, anon;
grant execute on function public.renewal_due_at(date) to authenticated, service_role;
grant execute on function public.renewal_event_title(text, text, public.policy_product) to authenticated, service_role;
