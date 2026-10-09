-- CapitUpIndia LMS: fixes from the edge-case test pass
-- (supabase/tests/edge_cases.test.sql).
--
--   * A signup name over 120 characters blocked the account from being
--     created; it is now cut to fit.
--   * A long client name with a renewal date failed to save, because the
--     reminder titles went over their 300-character limit; titles are now cut.
--   * find_similar_leads() and lead_duplicate_state() answered deactivated
--     users whose session had not expired yet. Their "is this an end user?"
--     check used is_privileged_session(), which inside a SECURITY DEFINER
--     function always sees the function owner, so it always passed. They now
--     look at the request's role (is_end_user_request()), which SECURITY
--     DEFINER does not change.

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
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)), 120)
  );
  return new;
end;
$$;

create or replace function public.renewal_event_title(p_milestone text, p_client_name text, p_product public.policy_product)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(case
    when p_milestone = 'DUE' then 'Renewal due: ' || p_client_name || ' (' || p_product::text || ')'
    else p_milestone || ' renewal reminder: ' || p_client_name || ' (' || p_product::text || ')'
  end, 300);
$$;

-- True for a signed-in or anonymous API request, also inside SECURITY
-- DEFINER functions (the role setting PostgREST applies survives them,
-- unlike current_user). False for the dashboard, migrations and jobs.
create or replace function public.is_end_user_request()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('role', true), 'none') in ('authenticated', 'anon');
$$;

create or replace function public.lead_duplicate_state(p_client_name text, p_exclude_id bigint default null)
returns table (is_duplicate boolean, duplicate_label text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.is_end_user_request() and not public.is_active_user() then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  return query
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
end;
$$;


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
  if public.is_end_user_request() and not public.is_active_user() then
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

revoke execute on function public.is_end_user_request() from public, anon;
revoke execute on function public.lead_duplicate_state(text, bigint) from public, anon;
revoke execute on function public.find_similar_leads(text, bigint, real, integer) from public, anon;
grant execute on function public.is_end_user_request() to authenticated, service_role;
grant execute on function public.lead_duplicate_state(text, bigint) to authenticated, service_role;
grant execute on function public.find_similar_leads(text, bigint, real, integer) to authenticated, service_role;
