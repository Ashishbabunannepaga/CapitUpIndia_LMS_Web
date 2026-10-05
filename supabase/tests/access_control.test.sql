-- Access-control, duplicate and renewal-milestone tests.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase_stub.sql).
-- Any failed assertion raises and stops the run (psql ON_ERROR_STOP).

\set ON_ERROR_STOP on
set client_min_messages = warning;

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

create function tests.ok(condition boolean, description text) returns void
language plpgsql as $$
begin
  if condition is not true then
    raise exception 'FAILED: %', description;
  end if;
  raise notice 'ok - %', description;
end;
$$;

-- Runs a statement and asserts it fails.
create function tests.throws(statement text, description text) returns void
language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    raise notice 'ok - % (%)', description, sqlerrm;
    return;
  end;
  raise exception 'FAILED: % (statement succeeded)', description;
end;
$$;

-- Switch to an API session for a user (null = anonymous).
create function tests.login(user_id uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when user_id is null then '{"role":"anon"}'
         else json_build_object('sub', user_id, 'role', 'authenticated')::text end,
    false);
end;
$$;

grant execute on all functions in schema tests to anon, authenticated, service_role;
set client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'Admin@CapitUp.in', '{"full_name":"Asha Admin"}'),
  ('00000000-0000-0000-0000-000000000001', 'amit@capitup.in', '{"full_name":"Amit","role":"ADMIN"}'),
  ('00000000-0000-0000-0000-000000000002', 'neha@capitup.in', '{"full_name":"Neha"}'),
  ('00000000-0000-0000-0000-000000000003', 'old@capitup.in', '{}');

select tests.ok((select count(*) = 4 from public.profiles), 'profiles are created for new auth users');
select tests.ok(
  (select role = 'AGENT' from public.profiles where id = '00000000-0000-0000-0000-000000000001'),
  'signup metadata cannot grant ADMIN');
select tests.ok(
  (select email = 'admin@capitup.in' from public.profiles where id = '00000000-0000-0000-0000-00000000000a'),
  'profile email is lowercased');

update public.profiles set role = 'ADMIN' where id = '00000000-0000-0000-0000-00000000000a';
update public.profiles set is_active = false where id = '00000000-0000-0000-0000-000000000003';

-- ---------------------------------------------------------------------------
-- Anonymous
-- ---------------------------------------------------------------------------

set role anon;
select tests.login(null);
select tests.throws('select * from public.leads', 'anon cannot read leads');
select tests.throws('select * from public.profiles', 'anon cannot read profiles');
select tests.throws($$select * from public.find_similar_leads('x')$$, 'anon cannot call duplicate lookup');
reset role;

-- ---------------------------------------------------------------------------
-- Admin creates and assigns leads
-- ---------------------------------------------------------------------------

set role authenticated;
select tests.login('00000000-0000-0000-0000-00000000000a');

insert into public.leads (client_name, type, policy_product, renewal_date, poc_name, assigned_agent_id)
values
  ('Renee Systems Pvt. Ltd.', 'Renewal', 'Health', current_date + 60, 'Rajesh', '00000000-0000-0000-0000-000000000001'),
  ('Kaveri Textiles', 'New', 'Fire or Property', null, '', '00000000-0000-0000-0000-000000000002');

select tests.ok((select count(*) = 2 from public.leads), 'admin sees all leads');
select tests.ok(
  (select poc_designation = 'poc' from public.leads where client_name = 'Renee Systems Pvt. Ltd.'),
  'designation defaults to poc');

-- ---------------------------------------------------------------------------
-- Agent isolation
-- ---------------------------------------------------------------------------

select tests.login('00000000-0000-0000-0000-000000000001'); -- Amit
select tests.ok((select count(*) = 1 from public.leads), 'agent sees only assigned leads');
select tests.ok((select client_name = 'Renee Systems Pvt. Ltd.' from public.leads), 'agent sees their own lead');

select tests.throws(
  $$insert into public.leads (client_name, assigned_agent_id) values ('Sneaky Co', '00000000-0000-0000-0000-000000000002')$$,
  'agent cannot create a lead for another agent');
select tests.throws(
  $$insert into public.leads (client_name) values ('Orphan Co')$$,
  'agent cannot create an unassigned lead');

insert into public.leads (client_name, assigned_agent_id)
values ('Amit Own Co', '00000000-0000-0000-0000-000000000001');
select tests.ok(
  (select created_by = '00000000-0000-0000-0000-000000000001' from public.leads where client_name = 'Amit Own Co'),
  'created_by is set from the session');

select tests.throws(
  $$update public.leads set assigned_agent_id = '00000000-0000-0000-0000-000000000002' where client_name = 'Amit Own Co'$$,
  'agent cannot reassign a lead');
select tests.throws(
  $$update public.leads set is_duplicate = true where client_name = 'Amit Own Co'$$,
  'agent cannot change duplicate state');

update public.leads set status = 'Quoted' where client_name = 'Amit Own Co';
select tests.ok(
  (select status = 'Quoted' from public.leads where client_name = 'Amit Own Co'),
  'agent can update status on their lead');

update public.leads set status = 'Closed Lost' where client_name = 'Kaveri Textiles';
delete from public.leads where client_name = 'Amit Own Co';
reset role;
select tests.ok(
  (select status = 'Prospect' from public.leads where client_name = 'Kaveri Textiles'),
  'agent update on another agent''s lead has no effect');
select tests.ok(
  (select count(*) = 1 from public.leads where client_name = 'Amit Own Co'),
  'agent cannot delete leads');

set role authenticated;
select tests.login('00000000-0000-0000-0000-000000000001');
select tests.throws(
  $$update public.profiles set role = 'ADMIN' where id = '00000000-0000-0000-0000-000000000001'$$,
  'agent cannot promote themselves');
update public.profiles set full_name = 'Amit Kumar' where id = '00000000-0000-0000-0000-000000000001';
select tests.ok(
  (select full_name = 'Amit Kumar' from public.profiles where id = '00000000-0000-0000-0000-000000000001'),
  'agent can rename themselves');
select tests.ok((select count(*) = 4 from public.profiles), 'active users can see the team');

-- ---------------------------------------------------------------------------
-- Duplicate detection
-- ---------------------------------------------------------------------------

select tests.login('00000000-0000-0000-0000-000000000002'); -- Neha
insert into public.leads (client_name, assigned_agent_id)
values ('  renee systems  ', '00000000-0000-0000-0000-000000000002');

select tests.ok(
  (select is_duplicate and duplicate_label = 'Duplicate: Already being processed by agent(s) [Amit Kumar]'
     from public.leads where client_name = 'renee systems'),
  'exact normalized match marks the new lead duplicate with the other agent''s name');

select tests.ok(
  (select count(*) = 1 and bool_and(assigned_agent_name = 'Amit Kumar')
     from public.find_similar_leads('Renee Systems India Pvt Ltd', null)
     where client_name = 'Renee Systems Pvt. Ltd.'),
  'fuzzy lookup finds Renee Systems for "Renee Systems India Pvt Ltd" across agents');

select tests.ok(
  (select count(*) = 0 from public.find_similar_leads('Zephyr Logistics')),
  'fuzzy lookup does not match unrelated names');

reset role;
set role authenticated;
select tests.login('00000000-0000-0000-0000-00000000000a');
update public.leads set is_duplicate = false where client_name = 'renee systems';
select tests.ok(
  (select not is_duplicate and duplicate_label = '' and duplicate_resolved_by = '00000000-0000-0000-0000-00000000000a'
     from public.leads where client_name = 'renee systems'),
  'admin can resolve a duplicate');

-- ---------------------------------------------------------------------------
-- Renewal milestones
-- ---------------------------------------------------------------------------

select tests.ok(
  (select count(*) = 10 from public.events e join public.leads l on l.id = e.lead_id
    where l.client_name = 'Renee Systems Pvt. Ltd.' and e.is_system_generated),
  'renewal date creates the due event and nine reminders');

select tests.ok(
  (select count(*) = 1 from public.events e join public.leads l on l.id = e.lead_id
    where l.client_name = 'Renee Systems Pvt. Ltd.' and not e.is_background_reminder),
  'only the due event is visible on the calendar');

select tests.ok(
  (select e.event_timestamp = ((l.renewal_date + time '10:00') at time zone 'Asia/Kolkata')
     from public.events e join public.leads l on l.id = e.lead_id
    where l.client_name = 'Renee Systems Pvt. Ltd.' and e.milestone = 'DUE'),
  'due event is at 10:00 IST on the renewal date');

select tests.ok(
  (select e.event_timestamp = public.renewal_due_at(l.renewal_date) - interval '5 minutes'
     from public.events e join public.leads l on l.id = e.lead_id
    where l.client_name = 'Renee Systems Pvt. Ltd.' and e.milestone = 'T-5 Minutes'),
  'T-5 Minutes reminder is five minutes before due');

update public.leads set renewal_date = current_date + 2 where client_name = 'Renee Systems Pvt. Ltd.';
select tests.ok(
  (select count(*) = 1 + 5 from public.events e join public.leads l on l.id = e.lead_id
    where l.client_name = 'Renee Systems Pvt. Ltd.' and e.is_system_generated),
  'moving the renewal date regenerates milestones and skips past ones');

update public.leads set assigned_agent_id = '00000000-0000-0000-0000-000000000002'
 where client_name = 'Renee Systems Pvt. Ltd.';
select tests.ok(
  (select bool_and(e.assigned_agent_id = '00000000-0000-0000-0000-000000000002')
     from public.events e join public.leads l on l.id = e.lead_id
    where l.client_name = 'Renee Systems Pvt. Ltd.'),
  'reassigning a lead moves its reminders to the new agent');

select tests.login('00000000-0000-0000-0000-000000000002'); -- Neha now owns it
select tests.throws(
  $$update public.events set event_timestamp = now() where milestone = 'DUE'$$,
  'agent cannot move a renewal milestone');
select tests.throws(
  $$insert into public.events (title, event_timestamp, assigned_agent_id, is_background_reminder)
    values ('fake', now(), '00000000-0000-0000-0000-000000000002', true)$$,
  'agent cannot create background reminders');

update public.events set is_completed = true where milestone = 'DUE';
select tests.ok(
  (select is_completed and completed_at is not null from public.events where milestone = 'DUE'),
  'agent can complete their renewal event');

insert into public.events (title, event_timestamp, assigned_agent_id)
values ('Call Rajesh', now() + interval '1 day', '00000000-0000-0000-0000-000000000002');
select tests.ok((select count(*) = 1 from public.events where title = 'Call Rajesh'), 'agent can add their own task');

select tests.login('00000000-0000-0000-0000-000000000001'); -- Amit lost the lead
select tests.ok((select count(*) = 0 from public.events where milestone is not null), 'previous owner no longer sees its reminders');

-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------

insert into public.lead_notes (lead_id, content, agent_name)
select id, 'Sent quote for GMC renewal', 'Somebody Else' from public.leads where client_name = 'Amit Own Co';
select tests.ok(
  (select agent_name = 'Amit Kumar' from public.lead_notes),
  'note author name comes from the profile, not the client');

select tests.throws(
  $$insert into public.lead_notes (lead_id, content) values (2, 'peek')$$, -- lead 2 is Kaveri Textiles (Neha's)
  'agent cannot add notes to a lead they cannot see');

select tests.login('00000000-0000-0000-0000-000000000002'); -- Neha
select tests.ok((select count(*) = 0 from public.lead_notes), 'notes on other agents'' leads are hidden');

-- ---------------------------------------------------------------------------
-- AI usage accounting
-- ---------------------------------------------------------------------------

select tests.throws(
  $$insert into public.ai_usage_logs (user_id, agent_name, feature_name, model_name, input_tokens, output_tokens, cost_inr)
    values ('00000000-0000-0000-0000-000000000002', 'Neha', 'lead_intake', 'gemini-2.5-flash', 1, 1, 0)$$,
  'agents cannot write AI usage logs');
reset role;

set role service_role;
insert into public.ai_usage_logs (user_id, agent_name, feature_name, model_name, input_tokens, output_tokens, cost_inr)
values ('00000000-0000-0000-0000-000000000002', '', 'lead_intake', 'gemini-2.5-flash', 1000000, 1000000, 999);
reset role;
select tests.ok(
  (select cost_inr = round((0.075 + 0.30) * 83.50, 4) and agent_name = 'Neha' from public.ai_usage_logs),
  'AI cost is computed in INR from central pricing');

set role authenticated;
select tests.login('00000000-0000-0000-0000-000000000001');
select tests.ok((select count(*) = 0 from public.ai_usage_logs), 'agents only see their own AI usage');
update public.app_settings set value = '1' where key = 'usd_to_inr';
reset role;
select tests.ok((select value = '83.50'::jsonb from public.app_settings where key = 'usd_to_inr'), 'agents cannot change settings');

-- ---------------------------------------------------------------------------
-- Inactive users, last admin, audit log
-- ---------------------------------------------------------------------------

update public.leads set assigned_agent_id = '00000000-0000-0000-0000-000000000003' where client_name = 'Kaveri Textiles';
set role authenticated;
select tests.login('00000000-0000-0000-0000-000000000003');
select tests.ok((select count(*) = 0 from public.leads), 'inactive users see no leads');
select tests.ok((select count(*) = 0 from public.profiles), 'inactive users see no profiles');

select tests.login('00000000-0000-0000-0000-00000000000a');
select tests.throws(
  $$update public.profiles set role = 'AGENT' where id = '00000000-0000-0000-0000-00000000000a'$$,
  'the last active admin cannot be demoted');
select tests.ok(
  (select count(*) > 0 from public.audit_logs where table_name = 'leads' and action = 'UPDATE'),
  'lead changes are written to the audit log');

select tests.login('00000000-0000-0000-0000-000000000001');
select tests.ok((select count(*) = 0 from public.audit_logs), 'agents cannot read the audit log');
reset role;

-- ---------------------------------------------------------------------------
-- Agent workspace: assignment time, POC merging, unread notes
-- ---------------------------------------------------------------------------

set role authenticated;
select tests.login('00000000-0000-0000-0000-00000000000a');
insert into public.leads (client_name, assigned_agent_id, poc_name, poc_designation, poc_contact_number)
values ('Merge Test Co', '00000000-0000-0000-0000-000000000002', '', '', '');
select tests.ok(
  (select assigned_at is not null from public.leads where client_name = 'Merge Test Co'),
  'assigned_at is set when a lead is created with an owner');
insert into public.leads (client_name) values ('Unowned Co');
select tests.ok(
  (select assigned_at is null from public.leads where client_name = 'Unowned Co'),
  'unassigned leads have no assigned_at');
update public.leads set assigned_at = '2000-01-01' where client_name = 'Merge Test Co';
select tests.ok(
  (select assigned_at > '2000-01-02' from public.leads where client_name = 'Merge Test Co'),
  'assigned_at cannot be written directly');
update public.leads set assigned_agent_id = '00000000-0000-0000-0000-000000000002' where client_name = 'Unowned Co';
select tests.ok(
  (select assigned_at is not null from public.leads where client_name = 'Unowned Co'),
  'assigning a lead sets assigned_at');

select tests.login('00000000-0000-0000-0000-000000000002'); -- Neha owns Merge Test Co
select tests.ok(
  (select public.add_lead_contact(id, 'Rajesh', 'Director', '98450 12345', 'Rajesh@Acme.in') = 'poc1'
     from public.leads where client_name = 'Merge Test Co'),
  'first contact fills an empty POC 1');
select tests.ok(
  (select poc_name = 'Rajesh' and poc_designation = 'Director' and poc_email_id = 'rajesh@acme.in'
     from public.leads where client_name = 'Merge Test Co'),
  'explicit designation is kept');
select tests.ok(
  (select public.add_lead_contact(id, 'Priya', '', '', 'priya@acme.in') = 'poc2'
     from public.leads where client_name = 'Merge Test Co'),
  'second contact fills POC 2');
select tests.ok(
  (select poc2_designation = 'poc' from public.leads where client_name = 'Merge Test Co'),
  'designation defaults to poc for merged contacts');
select tests.ok(
  (select public.add_lead_contact(id, 'Someone', '', '+91 98450-12345', '') = 'existing'
     from public.leads where client_name = 'Merge Test Co'),
  'a contact already on the lead (same phone) is not added twice');
select tests.ok(
  (select public.add_lead_contact(id, 'Vikram', 'CFO', '9000000000', '') = 'notes'
     from public.leads where client_name = 'Merge Test Co'),
  'third contact goes to notes');
select tests.ok(
  (select poc_name = 'Rajesh' and poc2_name = 'Priya'
      and notes like '%[Additional Contact: Vikram (CFO) - 9000000000]%'
     from public.leads where client_name = 'Merge Test Co'),
  'existing POCs are never overwritten');

select tests.login('00000000-0000-0000-0000-000000000001'); -- Amit
select tests.throws(
  $$select public.add_lead_contact((select id from public.leads where client_name = 'Merge Test Co'), 'X')$$,
  'agent cannot add contacts to another agent''s lead');

-- Notes: Neha writes on her lead, the admin sees it unread.
select tests.login('00000000-0000-0000-0000-000000000002');
insert into public.lead_notes (lead_id, content)
select id, 'Met Rajesh, quote by Friday' from public.leads where client_name = 'Merge Test Co';
select tests.ok(public.count_unread_lead_notes() = 0, 'your own notes are never unread');

select tests.login('00000000-0000-0000-0000-00000000000a');
select tests.ok(public.count_unread_lead_notes() >= 2, 'admin sees agents'' notes as unread');
select tests.ok(
  (select count(*) = 1 from public.unread_lead_notes(10) where client_name = 'Merge Test Co'),
  'unread feed carries the lead name');
select tests.ok(
  (select public.mark_lead_notes_read((select id from public.leads where client_name = 'Merge Test Co')) = 1),
  'marking one lead read marks its notes');
select tests.ok(
  (select count(*) = 0 from public.unread_lead_notes(10) where client_name = 'Merge Test Co'),
  'read notes leave the feed');
select public.mark_lead_notes_read(null);
select tests.ok(public.count_unread_lead_notes() = 0, 'mark all read clears the badge');

select tests.login('00000000-0000-0000-0000-000000000001'); -- Amit cannot see Neha's notes
select tests.ok(
  (select count(*) = 0 from public.unread_lead_notes(10) where client_name = 'Merge Test Co'),
  'unread feed respects lead visibility');
reset role;

-- ---------------------------------------------------------------------------
-- AI and automation: reminder delivery, notifications, round-robin,
-- visiting cards, analytics
-- ---------------------------------------------------------------------------

set role authenticated;
select tests.login('00000000-0000-0000-0000-00000000000a');
insert into public.leads (client_name, renewal_date, poc_name, poc_contact_number, assigned_agent_id)
values ('Reminder Co', current_date + 20, 'Sunil', '9845011111', '00000000-0000-0000-0000-000000000002'),
       ('Orphan Renewal Co', current_date + 20, '', '', null),
       ('Closed Renewal Co', current_date + 20, '', '', '00000000-0000-0000-0000-000000000002');
update public.leads set status = 'Closed Won' where client_name = 'Closed Renewal Co';
reset role;

-- Pretend T-10 and T-5 Days are already due for all three leads.
update public.events e set event_timestamp = now() - case e.milestone when 'T-10 Days' then interval '2 minutes' else interval '1 minute' end
  from public.leads l
 where l.id = e.lead_id and l.client_name in ('Reminder Co', 'Orphan Renewal Co', 'Closed Renewal Co')
   and e.milestone in ('T-10 Days', 'T-5 Days');

set role authenticated;
select tests.login('00000000-0000-0000-0000-000000000002');
select tests.throws($$select public.deliver_due_reminders()$$, 'users cannot run the reminder job');
reset role;

set role service_role;
select tests.ok(public.deliver_due_reminders() = 2, 'due reminders notify the agent and the admins of an unassigned lead');
select tests.ok(public.deliver_due_reminders() = 0, 'reminders are delivered only once');
reset role;

select tests.ok(
  (select count(*) = 6 from public.events e join public.leads l on l.id = e.lead_id
    where l.client_name in ('Reminder Co', 'Orphan Renewal Co', 'Closed Renewal Co') and e.reminder_sent_at is not null),
  'every due reminder is marked sent, including closed leads');
select tests.ok(
  (select count(*) = 0 from public.events e join public.leads l on l.id = e.lead_id
    where l.client_name = 'Reminder Co' and e.milestone = 'T-3 Days' and e.reminder_sent_at is not null),
  'future reminders stay pending');
select tests.ok(
  (select count(*) = 1 and bool_and(n.milestone = 'T-5 Days' and n.title like 'T-5 Days: Reminder Co renewal%'
                                    and n.body like '%Sunil (9845011111)%')
     from public.notifications n where n.user_id = '00000000-0000-0000-0000-000000000002'),
  'one notification per lead, for the latest due milestone');
select tests.ok(
  (select count(*) = 1 from public.notifications n join public.leads l on l.id = n.lead_id
    where l.client_name = 'Orphan Renewal Co' and n.user_id = '00000000-0000-0000-0000-00000000000a'),
  'unassigned renewals notify admins');
select tests.ok(
  (select count(*) = 0 from public.notifications n join public.leads l on l.id = n.lead_id
    where l.client_name = 'Closed Renewal Co'),
  'closed leads are not announced');

set role authenticated;
select tests.login('00000000-0000-0000-0000-000000000001'); -- Amit
select tests.ok((select count(*) = 0 from public.notifications), 'users only see their own notifications');
update public.notifications set read_at = now();
select tests.login('00000000-0000-0000-0000-000000000002'); -- Neha
select tests.ok((select count(*) = 1 and bool_and(read_at is null) from public.notifications),
  'another user cannot mark your notifications read');
update public.notifications set read_at = now();
select tests.ok((select bool_and(read_at is not null) from public.notifications), 'users can mark their notifications read');
select tests.throws($$update public.notifications set title = 'x'$$, 'users cannot edit notification content');
select tests.throws(
  $$insert into public.notifications (user_id, kind, title) values ('00000000-0000-0000-0000-000000000002', 'other', 'x')$$,
  'users cannot create notifications');

-- Round-robin: active AGENTs only (Amit Kumar, Neha), continuing across imports.
select tests.throws($$select public.next_round_robin_agents(2)$$, 'agents cannot run round-robin');
select tests.login('00000000-0000-0000-0000-00000000000a');
select tests.ok(
  public.next_round_robin_agents(3) = array['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
                                             '00000000-0000-0000-0000-000000000001']::uuid[],
  'round-robin cycles through active agents in name order');
select tests.ok(
  public.next_round_robin_agents(1) = array['00000000-0000-0000-0000-000000000002']::uuid[],
  'round-robin continues where the last import stopped');

-- Visiting cards: users can only attach cards they uploaded.
select tests.login('00000000-0000-0000-0000-000000000002');
update public.leads set visiting_card_path = '00000000-0000-0000-0000-000000000002/card.jpg' where client_name = 'Reminder Co';
select tests.ok(
  (select visiting_card_path is not null from public.leads where client_name = 'Reminder Co'),
  'agent can attach their own uploaded card');
select tests.throws(
  $$update public.leads set visiting_card_path = '00000000-0000-0000-0000-000000000001/card.jpg' where client_name = 'Reminder Co'$$,
  'agent cannot attach someone else''s card');

-- Analytics follow RLS.
select tests.ok(
  (select (public.pipeline_analytics() ->> 'total')::int = (select count(*) from public.leads)),
  'agent analytics count only their leads');
select tests.login('00000000-0000-0000-0000-00000000000a');
select tests.ok(
  (select (a ->> 'total')::int > 5 and (a -> 'renewals' ->> 'month')::int >= 2 and jsonb_array_length(a -> 'agents') >= 2
     from public.pipeline_analytics() a),
  'admin analytics cover every lead and agent');
select tests.ok(
  (select (s ->> 'calls')::int = 1 and (s -> 'by_feature' -> 0 ->> 'feature_name') = 'lead_intake'
     from public.ai_usage_summary(now() - interval '1 day') s),
  'AI usage summary totals calls by feature');
select tests.login('00000000-0000-0000-0000-000000000001');
select tests.ok(
  (select (s ->> 'calls')::int = 0 from public.ai_usage_summary(now() - interval '1 day') s),
  'agents only see their own AI usage in the summary');
reset role;

\echo 'All database tests passed.'
