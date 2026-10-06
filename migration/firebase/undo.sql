-- Undoes the Firebase import: deletes exactly the leads and calendar events that
-- import.sql created (their notes, renewal reminders and notifications go with
-- them) and removes the import marker, so a corrected import.sql can run again.
--
-- Only for straight after the import. It refuses once anyone has worked on the
-- imported leads (edited a lead, added a note or a calendar event), because that
-- work would be deleted too.
--
-- Run as the database owner, like import.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f undo.sql
-- or paste it into the Supabase SQL editor. Everything happens in one transaction.

begin;

do $$
declare
  v_marker jsonb;
  v_at timestamptz;
  v_leads bigint[];
  v_events bigint[];
  v_edited integer;
  v_notes integer;
  v_work_events integer;
  v_deleted_leads integer;
  v_deleted_events integer;
begin
  select value into v_marker from public.app_settings where key = 'firebase_import' for update;
  if v_marker is null then
    raise exception 'There is no Firebase import to undo (app_settings.firebase_import is missing)';
  end if;
  if not (v_marker ? 'lead_ids') then
    raise exception 'This import was made by an older import.sql that did not record what it created, so it cannot be undone automatically';
  end if;

  v_at := (v_marker ->> 'imported_at')::timestamptz;
  v_leads := array(select jsonb_array_elements_text(v_marker -> 'lead_ids')::bigint);
  v_events := array(select jsonb_array_elements_text(coalesce(v_marker -> 'event_ids', '[]'))::bigint);

  select count(*) into v_edited from public.leads l where l.id = any (v_leads) and l.updated_at > v_at;
  select count(*) into v_notes from public.lead_notes n where n.lead_id = any (v_leads) and n.created_at > v_at;
  select count(*) into v_work_events from public.events e
  where not e.is_system_generated and e.updated_at > v_at and (e.lead_id = any (v_leads) or e.id = any (v_events));
  if v_edited + v_notes + v_work_events > 0 then
    raise exception 'People have worked on the imported data since the import (% leads edited, % notes added, % calendar events added or changed); undoing would delete that work',
      v_edited, v_notes, v_work_events
      using hint = 'Undo is only for straight after the import. Fix what is wrong in the app instead.';
  end if;

  delete from public.events e where e.id = any (v_events);
  get diagnostics v_deleted_events = row_count;
  delete from public.leads l where l.id = any (v_leads);
  get diagnostics v_deleted_leads = row_count;
  delete from public.app_settings where key = 'firebase_import';

  raise notice 'Removed % imported leads and % imported calendar events. The import can be run again.',
    v_deleted_leads, v_deleted_events;
end $$;

commit;
