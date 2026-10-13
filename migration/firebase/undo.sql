-- Undoes the Firebase import: deletes exactly the leads and calendar events that
-- import.sql created (their notes, renewal reminders and notifications go with
-- them) and removes the import marker, so a corrected import.sql can run again.
--
-- Only for straight after the import. It refuses once anyone has worked on the
-- imported leads (edited a lead, added a note or a calendar event), because that
-- work would be deleted too.
--
--   npx wrangler d1 execute DB --remote --file undo.sql
--
-- If any statement fails, D1 puts the database back as it was.

drop table if exists _firebase_import_undo_guard;
create table _firebase_import_undo_guard (
  imported integer constraint "There is no Firebase import to undo" check (imported is null or imported),
  untouched integer constraint "People have worked on the imported leads since the import (edited a lead, added a note or a calendar event); undoing would delete that work, so fix what is wrong in the app instead" check (untouched is null or untouched)
);
insert into _firebase_import_undo_guard (imported)
  select exists (select 1 from app_settings where key = 'firebase_import')
     and (select count(*) from sqlite_master where type = 'table' and name in ('firebase_import_leads', 'firebase_import_events')) = 2;

insert into _firebase_import_undo_guard (untouched)
  select not exists (
    select 1 from leads l join firebase_import_leads m on m.lead_id = l.id
    where l.updated_at > (select json_extract(value, '$.imported_at') from app_settings where key = 'firebase_import')
  ) and not exists (
    select 1 from lead_notes n join firebase_import_leads m on m.lead_id = n.lead_id
    where n.created_at > (select json_extract(value, '$.imported_at') from app_settings where key = 'firebase_import')
  ) and not exists (
    select 1 from events e
    where not e.is_system_generated
      and e.updated_at > (select json_extract(value, '$.imported_at') from app_settings where key = 'firebase_import')
      and (e.lead_id in (select lead_id from firebase_import_leads) or e.id in (select event_id from firebase_import_events))
  );

-- What is about to be removed.
select (select count(*) from firebase_import_leads) as leads_removed, (select count(*) from firebase_import_events) as events_removed;

delete from events where id in (select event_id from firebase_import_events);
delete from leads where id in (select lead_id from firebase_import_leads);
delete from app_settings where key = 'firebase_import';
drop table firebase_import_leads;
drop table firebase_import_events;
drop table _firebase_import_undo_guard;
