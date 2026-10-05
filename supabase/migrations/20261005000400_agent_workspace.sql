-- CapitUpIndia LMS: agent workspace support.
--
--   * leads.assigned_at: when the current owner got the lead (My Day's
--     "recent assignments"), maintained by the database.
--   * add_lead_contact(): the POC merge rule. Fill POC 1 if empty, else POC 2
--     if empty, else append the contact to the lead's notes. Never overwrites
--     an existing contact.
--   * unread_lead_notes() / count_unread_lead_notes() / mark_lead_notes_read():
--     the "new notes" feed and badge, using lead_note_reads.
-- All functions are SECURITY INVOKER, so RLS decides which leads and notes the
-- caller can touch.

-- ---------------------------------------------------------------------------
-- Assignment timestamp
-- ---------------------------------------------------------------------------

alter table public.leads add column assigned_at timestamptz;

update public.leads set assigned_at = created_at where assigned_agent_id is not null;

create index leads_assigned_at_idx on public.leads (assigned_agent_id, assigned_at desc);

-- Runs after leads_before_write (triggers fire in name order). Clients cannot
-- set assigned_at themselves; it always follows assigned_agent_id.
create or replace function public.leads_track_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.assigned_at := case when new.assigned_agent_id is not null then now() end;
  elsif new.assigned_agent_id is distinct from old.assigned_agent_id then
    new.assigned_at := case when new.assigned_agent_id is not null then now() end;
  else
    new.assigned_at := old.assigned_at;
  end if;
  return new;
end;
$$;

create trigger leads_track_assignment
  before insert or update on public.leads
  for each row execute function public.leads_track_assignment();

-- ---------------------------------------------------------------------------
-- POC merging
-- ---------------------------------------------------------------------------

-- True when a POC slot holds no real contact. "Contact Person" is the
-- placeholder the old app's importers wrote when a sheet had no name.
create or replace function public.is_blank_poc(p_name text, p_phone text, p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (btrim(coalesce(p_name, '')) = '' or lower(btrim(p_name)) = 'contact person')
     and btrim(coalesce(p_phone, '')) = ''
     and btrim(coalesce(p_email, '')) = '';
$$;

-- Adds a contact to a lead without overwriting anyone.
-- Returns 'poc1', 'poc2' or 'notes' (where the contact went), or 'existing'
-- when the same person (by name, phone or email) is already on the lead.
create or replace function public.add_lead_contact(
  p_lead_id bigint,
  p_name text,
  p_designation text default '',
  p_phone text default '',
  p_email text default ''
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  l public.leads;
  v_name text := btrim(coalesce(p_name, ''));
  v_designation text := coalesce(nullif(btrim(coalesce(p_designation, '')), ''), 'poc');
  v_phone text := btrim(coalesce(p_phone, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  -- Last 10 digits, so "+91 98450-12345" matches "98450 12345".
  digits text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  line text;
begin
  if v_name = '' and v_phone = '' and v_email = '' then
    raise exception 'A contact needs a name, phone or email' using errcode = '22023';
  end if;
  if v_name = '' then
    v_name := 'Contact Person';
  end if;

  -- RLS applies: agents can only lock (and so change) their own leads.
  select * into l from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found', p_lead_id using errcode = 'P0002';
  end if;

  -- Same person already on the lead?
  if (lower(v_name) <> 'contact person' and lower(v_name) in (lower(btrim(l.poc_name)), lower(btrim(l.poc2_name))))
     or (v_email <> '' and v_email in (l.poc_email_id, l.poc2_email_id))
     or (length(digits) >= 8 and (
          position(digits in regexp_replace(l.poc_contact_number, '\D', '', 'g')) > 0
          or position(digits in regexp_replace(l.poc2_contact_number, '\D', '', 'g')) > 0))
  then
    return 'existing';
  end if;

  if public.is_blank_poc(l.poc_name, l.poc_contact_number, l.poc_email_id) then
    update public.leads set
      poc_name = v_name,
      poc_designation = v_designation,
      poc_contact_number = v_phone,
      poc_email_id = v_email
    where id = p_lead_id;
    return 'poc1';
  end if;

  if public.is_blank_poc(l.poc2_name, l.poc2_contact_number, l.poc2_email_id) then
    update public.leads set
      poc2_name = v_name,
      poc2_designation = v_designation,
      poc2_contact_number = v_phone,
      poc2_email_id = v_email
    where id = p_lead_id;
    return 'poc2';
  end if;

  line := '[Additional Contact: ' || v_name || ' (' || v_designation || ')'
    || case when v_phone <> '' or v_email <> '' then ' - ' || concat_ws(', ', nullif(v_phone, ''), nullif(v_email, '')) else '' end
    || ']';
  update public.leads set
    notes = case when btrim(notes) = '' then line else notes || E'\n' || line end
  where id = p_lead_id;
  return 'notes';
end;
$$;

-- ---------------------------------------------------------------------------
-- Unread notes
-- ---------------------------------------------------------------------------

-- Notes on leads the caller can see, written by someone else, that the
-- caller has not read yet. Newest first.
create or replace function public.unread_lead_notes(p_limit integer default 50)
returns table (
  id bigint,
  lead_id bigint,
  client_name text,
  agent_id uuid,
  agent_name text,
  content text,
  created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select n.id, n.lead_id, l.client_name, n.agent_id, n.agent_name, n.content, n.created_at
  from public.lead_notes n
  join public.leads l on l.id = n.lead_id
  where n.agent_id is distinct from auth.uid()
    and not exists (
      select 1 from public.lead_note_reads r
      where r.note_id = n.id and r.user_id = auth.uid()
    )
  order by n.created_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create or replace function public.count_unread_lead_notes()
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
  from public.lead_notes n
  join public.leads l on l.id = n.lead_id
  where n.agent_id is distinct from auth.uid()
    and not exists (
      select 1 from public.lead_note_reads r
      where r.note_id = n.id and r.user_id = auth.uid()
    );
$$;

-- Marks the caller's unread notes as read, for one lead or (null) all leads.
-- Returns how many notes were marked.
create or replace function public.mark_lead_notes_read(p_lead_id bigint default null)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  marked integer;
begin
  insert into public.lead_note_reads (note_id, user_id)
  select n.id, auth.uid()
  from public.lead_notes n
  where (p_lead_id is null or n.lead_id = p_lead_id)
    and n.agent_id is distinct from auth.uid()
  on conflict (note_id, user_id) do nothing;
  get diagnostics marked = row_count;
  return marked;
end;
$$;

revoke execute on function
  public.leads_track_assignment(),
  public.is_blank_poc(text, text, text),
  public.add_lead_contact(bigint, text, text, text, text),
  public.unread_lead_notes(integer),
  public.count_unread_lead_notes(),
  public.mark_lead_notes_read(bigint)
from public, anon;

grant execute on function
  public.is_blank_poc(text, text, text),
  public.add_lead_contact(bigint, text, text, text, text),
  public.unread_lead_notes(integer),
  public.count_unread_lead_notes(),
  public.mark_lead_notes_read(bigint)
to authenticated, service_role;
