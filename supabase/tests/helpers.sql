-- Assertion helpers shared by the *.test.sql files (loaded first by
-- scripts/test-db.sh).

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
