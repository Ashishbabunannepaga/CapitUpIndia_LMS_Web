-- Edge cases and tamper attempts: what a user could send straight to the API
-- (bypassing the app's forms), unusual data, and lifecycle transitions.
-- Runs after access_control.test.sql on the same database.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Company-name normalization matches the app (shared fixture)
-- ---------------------------------------------------------------------------

\set fixture `cat supabase/tests/fixtures/company_names.json`
select tests.ok(public.normalize_company_name(key) = value, format('normalize_company_name(%L) = %L', key, value))
  from jsonb_each_text(:'fixture'::jsonb);
select tests.ok(public.normalize_company_name(null) = '', 'normalize_company_name(null) is empty');

-- ---------------------------------------------------------------------------
-- Users for this file
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b1', 'bina@capitup.in', '{"full_name":"Bina Admin"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'chetan@capitup.in', '{"full_name":"Chetan"}'),
  ('00000000-0000-0000-0000-0000000000c2', 'divya@capitup.in', '{"full_name":"Divya"}'),
  ('00000000-0000-0000-0000-0000000000c3', 'esha@capitup.in', '{"full_name":"Esha"}'),
  ('00000000-0000-0000-0000-0000000000c4', 'long@capitup.in', json_build_object('full_name', repeat('L', 200))::jsonb),
  ('00000000-0000-0000-0000-0000000000c5', 'blank@capitup.in', '{"full_name":"   "}');

select tests.ok(
  (select char_length(full_name) = 120 from public.profiles where id = '00000000-0000-0000-0000-0000000000c4'),
  'an over-long signup name is cut to fit instead of blocking the account');
select tests.ok(
  (select full_name = 'blank' from public.profiles where id = '00000000-0000-0000-0000-0000000000c5'),
  'a blank signup name falls back to the email name');

update public.profiles set role = 'ADMIN' where id = '00000000-0000-0000-0000-0000000000b1';
update public.profiles set is_active = false
 where id in ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000c5');

-- Divya's lead, created by an admin; its id is needed to aim at it directly.
set role authenticated;
select tests.login('00000000-0000-0000-0000-0000000000b1');
insert into public.leads (client_name, assigned_agent_id, poc_name)
values ('Divya Co', '00000000-0000-0000-0000-0000000000c2', 'Rohit');
reset role;
select id as divya_lead from public.leads where client_name = 'Divya Co' \gset
insert into public.lead_notes (lead_id, content, agent_id) values (:divya_lead, 'Divya''s private note', '00000000-0000-0000-0000-0000000000c2');
select id as divya_note from public.lead_notes where lead_id = :divya_lead \gset

-- ---------------------------------------------------------------------------
-- An agent forging server-owned lead fields
-- ---------------------------------------------------------------------------

set role authenticated;
select tests.login('00000000-0000-0000-0000-0000000000c1'); -- Chetan

insert into public.leads (client_name, assigned_agent_id, is_duplicate, duplicate_label, created_by, created_at,
                          assigned_at, duplicate_resolved_at, duplicate_resolved_by, poc_email_id, poc_designation)
values ('Forged Co', '00000000-0000-0000-0000-0000000000c1', true, 'fake', '00000000-0000-0000-0000-0000000000b1',
        '2000-01-01', '2000-01-01', now(), '00000000-0000-0000-0000-0000000000b1', '  Priya@Forged.IN ', '   ');
select tests.ok(
  (select not is_duplicate and duplicate_label = '' and duplicate_resolved_at is null and duplicate_resolved_by is null
     from public.leads where client_name = 'Forged Co'),
  'agents cannot forge duplicate state on create');
select tests.ok(
  (select created_by = '00000000-0000-0000-0000-0000000000c1' and created_at > now() - interval '1 minute'
          and assigned_at > now() - interval '1 minute'
     from public.leads where client_name = 'Forged Co'),
  'agents cannot forge who created a lead or when');
select tests.ok(
  (select poc_email_id = 'priya@forged.in' and poc_designation = 'poc' from public.leads where client_name = 'Forged Co'),
  'emails are trimmed and lowercased, a blank designation becomes poc');

update public.leads set assigned_at = '2000-01-01' where client_name = 'Forged Co';
select tests.ok(
  (select assigned_at > now() - interval '1 minute' from public.leads where client_name = 'Forged Co'),
  'assigned_at cannot be edited directly');
select tests.throws($$update public.leads set created_at = '2000-01-01' where client_name = 'Forged Co'$$,
  'agents cannot backdate a lead');
select tests.throws($$update public.leads set assigned_agent_id = null where client_name = 'Forged Co'$$,
  'agents cannot unassign their own lead');
select tests.throws($$update public.leads set visiting_card_path = '../00000000-0000-0000-0000-0000000000c1/x.jpg' where client_name = 'Forged Co'$$,
  'card paths must start with the uploader''s folder');

select tests.throws($$insert into public.leads (client_name, assigned_agent_id) values ('   ', '00000000-0000-0000-0000-0000000000c1')$$,
  'a blank client name is rejected');
select tests.throws(format('insert into public.leads (client_name, assigned_agent_id) values (%L, %L)', repeat('x', 301),
  '00000000-0000-0000-0000-0000000000c1'), 'a client name over 300 characters is rejected');
select tests.throws($$insert into public.leads (client_name, assigned_agent_id, poc_email_id) values ('Bad Mail Co', '00000000-0000-0000-0000-0000000000c1', 'priya@')$$,
  'an invalid email is rejected');
select tests.throws($$insert into public.leads (client_name, assigned_agent_id, poc_contact_number) values ('Long Phone Co', '00000000-0000-0000-0000-0000000000c1', repeat('9', 33))$$,
  'a phone field over 32 characters is rejected');

-- A 300-character name with a renewal date still gets its reminders.
insert into public.leads (client_name, assigned_agent_id, renewal_date, policy_product)
values (repeat('Long Name ', 30), '00000000-0000-0000-0000-0000000000c1', current_date + 60, 'Fire or Property');
select tests.ok(
  (select count(*) = 10 and max(char_length(e.title)) <= 300
     from public.events e join public.leads l on l.id = e.lead_id where l.client_name = btrim(repeat('Long Name ', 30))),
  'a maximum-length client name still gets every renewal reminder');

-- ---------------------------------------------------------------------------
-- An agent reaching into another agent's data by id
-- ---------------------------------------------------------------------------

select tests.ok((select count(*) = 0 from public.leads where id = :divya_lead), 'a lead id from someone else returns nothing');
select tests.throws(format('insert into public.events (title, event_timestamp, lead_id, assigned_agent_id) values (%L, now(), %s, %L)',
  'Spy', :divya_lead, '00000000-0000-0000-0000-0000000000c1'), 'agents cannot attach tasks to other agents'' leads');
select tests.throws($$insert into public.events (title, event_timestamp, assigned_agent_id) values ('Gift', now(), '00000000-0000-0000-0000-0000000000c2')$$,
  'agents cannot create tasks for other agents');
select tests.throws(format('insert into public.lead_notes (lead_id, content) values (%s, %L)', :divya_lead, 'hi'),
  'agents cannot write notes on other agents'' leads');
select tests.ok((select count(*) = 0 from public.lead_notes where id = :divya_note), 'agents cannot read other agents'' notes by id');
select tests.throws(format('insert into public.lead_note_reads (note_id) values (%s)', :divya_note),
  'agents cannot mark unseen notes read');
select tests.throws(format('select public.add_lead_contact(%s, %L)', :divya_lead, 'Spy'),
  'agents cannot add contacts to other agents'' leads');
select tests.ok(public.mark_lead_notes_read(:divya_lead) = 0, 'marking another agent''s lead read touches nothing');
update public.leads set notes = 'hijacked' where id = :divya_lead;
delete from public.lead_notes where id = :divya_note;
reset role;
select tests.ok((select notes = '' from public.leads where id = :divya_lead), 'updates aimed at another agent''s lead do nothing');
select tests.ok((select count(*) = 1 from public.lead_notes where id = :divya_note), 'agents cannot delete notes');

-- The fuzzy duplicate check names the owner of a similar company, nothing more.
set role authenticated;
select tests.login('00000000-0000-0000-0000-0000000000c1');
select tests.ok(
  (select count(*) = 1 and bool_and(assigned_agent_name = 'Divya')
     from public.find_similar_leads('Divya Co Pvt Ltd') where lead_id = :divya_lead),
  'duplicate warnings name the other agent');
select tests.ok(
  (select count(*) = 0 from public.find_similar_leads('   ')),
  'a blank name matches nothing');

-- ---------------------------------------------------------------------------
-- Notes and read receipts
-- ---------------------------------------------------------------------------

insert into public.lead_notes (lead_id, content, agent_id, agent_name, created_at)
select id, '  Called, quote by Friday  ', '00000000-0000-0000-0000-0000000000b1', 'The Boss', '2000-01-01'
  from public.leads where client_name = 'Forged Co';
select tests.ok(
  (select n.agent_id = '00000000-0000-0000-0000-0000000000c1' and n.agent_name = 'Chetan' and n.content = 'Called, quote by Friday'
          and n.created_at > now() - interval '1 minute'
     from public.lead_notes n join public.leads l on l.id = n.lead_id where l.client_name = 'Forged Co'),
  'notes are signed and dated by the server, not the client');
update public.lead_notes set content = 'rewritten history';
select tests.ok((select count(*) = 0 from public.lead_notes where content = 'rewritten history'), 'notes cannot be edited');
select tests.throws(
  $$insert into public.lead_notes (lead_id, content) select id, '   ' from public.leads where client_name = 'Forged Co'$$,
  'blank notes are rejected');
select tests.throws(
  format('insert into public.lead_note_reads (note_id, user_id) select id, %L from public.lead_notes limit 1',
         '00000000-0000-0000-0000-0000000000c2'),
  'users cannot write read receipts for someone else');

-- ---------------------------------------------------------------------------
-- POC merging
-- ---------------------------------------------------------------------------

insert into public.leads (client_name, assigned_agent_id, poc_name)
values ('Contact Co', '00000000-0000-0000-0000-0000000000c1', 'Contact Person');
select id as contact_lead from public.leads where client_name = 'Contact Co' \gset

select tests.throws(format('select public.add_lead_contact(%s, %L, %L, %L, %L)', :contact_lead, ' ', '', ' ', ''),
  'a contact needs a name, phone or email');
select tests.ok(public.add_lead_contact(:contact_lead, 'Priya', 'HR', '98450 12345', 'Priya@Contact.co') = 'poc1',
  'a "Contact Person" placeholder counts as an empty POC 1');
select tests.ok(public.add_lead_contact(:contact_lead, 'Anil', '', '', 'anil@contact.co') = 'poc2', 'the second contact fills POC 2');
select tests.ok(public.add_lead_contact(:contact_lead, 'Someone', '', '+91-98450-12345', '') = 'existing',
  'the same phone in another format is the same person');
select tests.ok(public.add_lead_contact(:contact_lead, 'PRIYA ', '', '', '') = 'existing', 'names match without case');
select tests.ok(public.add_lead_contact(:contact_lead, '', '', '', 'ANIL@contact.co') = 'existing', 'emails match without case');
select tests.ok(public.add_lead_contact(:contact_lead, 'Kiran', '', '9845099999', '') = 'notes', 'a third contact goes to notes');
select tests.ok(public.add_lead_contact(:contact_lead, '', '', '', 'ops@contact.co') = 'notes', 'a contact with only an email is kept');
select tests.ok(
  (select poc_name = 'Priya' and poc_designation = 'HR' and poc_email_id = 'priya@contact.co'
          and poc2_name = 'Anil' and poc2_designation = 'poc'
          and notes = E'[Additional Contact: Kiran (poc) - 9845099999]\n[Additional Contact: Contact Person (poc) - ops@contact.co]'
     from public.leads where id = :contact_lead),
  'contacts are merged without overwriting anyone');

-- ---------------------------------------------------------------------------
-- Tasks and renewal reminders
-- ---------------------------------------------------------------------------

select tests.throws(
  $$insert into public.events (title, event_timestamp, assigned_agent_id, is_background_reminder) values ('Fake reminder', now(), '00000000-0000-0000-0000-0000000000c1', true)$$,
  'agents cannot create background reminders');

update public.leads set renewal_date = current_date + 60 where id = :contact_lead;
select tests.ok(
  (select count(*) = 10 and count(*) filter (where is_background_reminder) = 9
     from public.events where lead_id = :contact_lead and is_system_generated),
  'a renewal date creates the due event and nine reminders');

select tests.throws(format('update public.events set title = %L where lead_id = %s and milestone = %L', 'x', :contact_lead, 'DUE'),
  'renewal events cannot be renamed');
select tests.throws(format('update public.events set event_timestamp = now() where lead_id = %s and milestone = %L', :contact_lead, 'DUE'),
  'renewal events cannot be moved');
select tests.throws(format('update public.events set reminder_sent_at = now() where lead_id = %s', :contact_lead),
  'agents cannot silence reminders');
delete from public.events where lead_id = :contact_lead;
select tests.ok((select count(*) = 10 from public.events where lead_id = :contact_lead), 'agents cannot delete renewal events');

update public.events set is_completed = true where lead_id = :contact_lead and milestone = 'DUE';
select tests.ok((select completed_at is not null from public.events where lead_id = :contact_lead and milestone = 'DUE'),
  'completing a task stamps it');
update public.events set is_completed = false where lead_id = :contact_lead and milestone = 'DUE';
select tests.ok((select completed_at is null from public.events where lead_id = :contact_lead and milestone = 'DUE'),
  'reopening a task clears the stamp');

update public.leads set renewal_date = current_date - 10 where id = :contact_lead;
select tests.ok(
  (select count(*) = 1 and bool_and(milestone = 'DUE') from public.events where lead_id = :contact_lead and is_system_generated),
  'a past renewal date gets its due event but no reminders');
update public.leads set renewal_date = null where id = :contact_lead;
select tests.ok((select count(*) = 0 from public.events where lead_id = :contact_lead and is_system_generated),
  'clearing the renewal date removes its events');

update public.leads set renewal_date = current_date + 60, client_name = 'Contact Company' where id = :contact_lead;
update public.leads set policy_product = 'Marine' where id = :contact_lead;
select tests.ok(
  (select bool_and(title like '%Contact Company (Marine)') from public.events where lead_id = :contact_lead and is_system_generated),
  'renaming a lead or changing its product renames its reminders');

-- Admin hands the lead to Divya: the reminders follow it.
select tests.login('00000000-0000-0000-0000-0000000000b1');
update public.leads set assigned_agent_id = '00000000-0000-0000-0000-0000000000c2' where id = :contact_lead;
select tests.ok(
  (select bool_and(assigned_agent_id = '00000000-0000-0000-0000-0000000000c2') from public.events
    where lead_id = :contact_lead and is_system_generated),
  'reassigning a lead moves its reminders');

-- A lead whose agent has left: reminders go to every active admin.
insert into public.leads (client_name, assigned_agent_id, renewal_date)
values ('Left Agent Co', '00000000-0000-0000-0000-0000000000c3', current_date + 60);
reset role;
select id as left_lead from public.leads where client_name = 'Left Agent Co' \gset
update public.events set event_timestamp = now() - interval '1 minute' where lead_id = :left_lead and milestone = 'T-30 Days';
set role service_role;
select tests.ok(public.deliver_due_reminders() = 2, 'a departed agent''s reminder goes to both active admins');
reset role;
select tests.ok(
  (select count(*) = 0 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000c3'),
  'inactive users get no notifications');

-- ---------------------------------------------------------------------------
-- Duplicate lifecycle
-- ---------------------------------------------------------------------------

set role authenticated;
select tests.login('00000000-0000-0000-0000-0000000000b1');
insert into public.leads (client_name, assigned_agent_id) values ('Lifecycle Ltd', '00000000-0000-0000-0000-0000000000c1');
insert into public.leads (client_name, assigned_agent_id) values ('lifecycle', '00000000-0000-0000-0000-0000000000c2');
select id as dup_lead from public.leads where client_name = 'lifecycle' \gset
select tests.ok(
  (select is_duplicate and duplicate_label = 'Duplicate: Already being processed by agent(s) [Chetan]'
     from public.leads where id = :dup_lead),
  'the newer lead is flagged with the existing owner');
select tests.ok((select not is_duplicate from public.leads where client_name = 'Lifecycle Ltd'), 'the original stays clean');

update public.leads set is_duplicate = false where id = :dup_lead;
select tests.ok(
  (select duplicate_label = '' and duplicate_resolved_by = '00000000-0000-0000-0000-0000000000b1' and duplicate_resolved_at is not null
     from public.leads where id = :dup_lead),
  'clearing a duplicate records who resolved it');
update public.leads set client_name = 'LIFECYCLE Pvt' where id = :dup_lead;
select tests.ok((select not is_duplicate and duplicate_resolved_at is not null from public.leads where id = :dup_lead),
  'respelling a resolved duplicate keeps it resolved');
update public.leads set client_name = 'Lifecycle Two' where id = :dup_lead;
select tests.ok((select not is_duplicate and duplicate_resolved_at is null from public.leads where id = :dup_lead),
  'a renamed lead is checked again');
update public.leads set client_name = 'Lifecycle' where id = :dup_lead;
select tests.ok((select is_duplicate from public.leads where id = :dup_lead), 'renaming into a duplicate flags it again');

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

select tests.login('00000000-0000-0000-0000-0000000000c1');
update public.profiles set full_name = 'Hacked' where id = '00000000-0000-0000-0000-0000000000c2';
select tests.ok((select full_name = 'Divya' from public.profiles where id = '00000000-0000-0000-0000-0000000000c2'),
  'agents cannot rename other users');
select tests.throws($$update public.profiles set is_active = false where id = '00000000-0000-0000-0000-0000000000c1'$$,
  'agents cannot change their own status');
select tests.throws($$update public.profiles set email = 'x@y.z' where id = '00000000-0000-0000-0000-0000000000c1'$$,
  'agents cannot change their email');
select tests.throws($$update public.profiles set full_name = '  ' where id = '00000000-0000-0000-0000-0000000000c1'$$,
  'names cannot be blank');
select tests.throws($$insert into public.profiles (id, email, full_name) values (gen_random_uuid(), 'x@y.z', 'X')$$,
  'users cannot create profiles');
select tests.throws($$delete from public.profiles$$, 'users cannot delete profiles');

-- Admin bookkeeping tables are server-only.
select tests.throws($$insert into public.ai_usage_logs (user_id, agent_name, feature_name, model_name, input_tokens, output_tokens, cost_inr) values ('00000000-0000-0000-0000-0000000000c1', 'Chetan', 'other', 'gemini-2.5-flash', 0, 0, 0)$$,
  'users cannot write AI usage');
select tests.throws($$insert into public.audit_logs (table_name, record_id, action) values ('leads', '1', 'DELETE')$$,
  'users cannot write the audit log');
select tests.throws($$insert into public.renewal_milestone_offsets values ('T-1 Minute', interval '1 minute', 99)$$,
  'users cannot change reminder offsets');
select tests.throws($$truncate public.leads$$, 'users cannot truncate tables');
select tests.throws($$select public.next_round_robin_agents(1)$$, 'agents cannot move the round-robin');

-- ---------------------------------------------------------------------------
-- Inactive users (a deactivated employee whose session is still alive)
-- ---------------------------------------------------------------------------

select tests.login('00000000-0000-0000-0000-0000000000c3'); -- Esha, inactive, still owns a lead
select tests.ok((select count(*) = 0 from public.leads), 'inactive users see none of their leads');
select tests.ok((select count(*) = 0 from public.events), 'inactive users see none of their tasks');
select tests.throws($$select * from public.find_similar_leads('Divya Co')$$, 'inactive users cannot search companies');
select tests.throws($$select * from public.lead_duplicate_state('Divya Co')$$, 'inactive users cannot probe duplicate owners');
select tests.throws(format('select public.add_lead_contact(%s, %L)', :left_lead, 'X'), 'inactive users cannot add contacts');
select tests.throws($$insert into public.leads (client_name, assigned_agent_id) values ('Late Co', '00000000-0000-0000-0000-0000000000c3')$$,
  'inactive users cannot create leads');
select tests.ok(public.count_unread_lead_notes() = 0, 'inactive users have no unread notes');
select tests.ok((select (public.pipeline_analytics() ->> 'total')::int = 0), 'inactive users get empty analytics');

-- Anonymous callers reach no function.
reset role;
set role anon;
select tests.login(null);
select tests.throws($$select public.pipeline_analytics()$$, 'anon cannot read analytics');
select tests.throws($$select public.lead_duplicate_state('Divya Co')$$, 'anon cannot probe duplicate owners');
select tests.throws(format('select public.add_lead_contact(%s, %L)', :divya_lead, 'X'), 'anon cannot add contacts');
select tests.throws($$select public.count_unread_lead_notes()$$, 'anon cannot read note counts');
select tests.throws($$select * from public.notifications$$, 'anon cannot read notifications');
reset role;

-- ---------------------------------------------------------------------------
-- Round-robin and the last admin
-- ---------------------------------------------------------------------------

set role authenticated;
select tests.login('00000000-0000-0000-0000-0000000000b1');
select tests.ok(public.next_round_robin_agents(0) = '{}'::uuid[], 'round-robin for zero leads is empty');
select tests.ok(public.next_round_robin_agents(null) = '{}'::uuid[], 'round-robin for no count is empty');
select tests.ok(
  (select count(*) = 8 and count(distinct a) = 4
          and bool_and(a in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
                             '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2'))
     from unnest(public.next_round_robin_agents(8)) a),
  'round-robin shares leads evenly between active agents only');

update public.profiles set is_active = false where id = '00000000-0000-0000-0000-0000000000b1';
select tests.login('00000000-0000-0000-0000-00000000000a'); -- Asha, now the only active admin
select tests.throws($$update public.profiles set role = 'AGENT' where id = '00000000-0000-0000-0000-00000000000a'$$,
  'the last active admin cannot demote themselves');
select tests.throws($$update public.profiles set is_active = false where id = '00000000-0000-0000-0000-00000000000a'$$,
  'the last active admin cannot deactivate themselves');
update public.profiles set is_active = true where id = '00000000-0000-0000-0000-0000000000b1';

-- Deleting a lead takes its notes, tasks and reminders with it, and is audited.
delete from public.leads where client_name = 'Forged Co';
reset role;
select tests.ok(
  (select count(*) = 0 from public.lead_notes n where not exists (select 1 from public.leads l where l.id = n.lead_id)),
  'deleting a lead removes its notes');
select tests.ok(
  (select count(*) = 1 from public.audit_logs
    where table_name = 'leads' and action = 'DELETE' and old_data ->> 'client_name' = 'Forged Co'
      and actor_id = '00000000-0000-0000-0000-00000000000a'),
  'lead deletions are audited with the admin who did it');

\echo 'All edge-case tests passed.'
