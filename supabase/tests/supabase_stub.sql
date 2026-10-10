-- Minimal stand-in for the parts of a Supabase database the migrations rely
-- on (auth schema, API roles, default grants), so migrations and RLS tests can
-- run against plain PostgreSQL in CI. Not used in real Supabase projects.
-- Still needed by migration/firebase/test/sql-load.sh until the Firebase
-- importer targets D1.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
create schema extensions;
grant usage on schema public, extensions, auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'
);

create function auth.uid() returns uuid
language sql stable
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
$$;

create function auth.role() returns text
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
$$;

grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

-- Supabase grants API roles full table privileges by default; RLS and the
-- migrations' explicit revokes are what actually restrict access.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
