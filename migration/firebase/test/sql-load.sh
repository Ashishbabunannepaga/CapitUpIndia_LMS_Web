#!/usr/bin/env bash
# Generates import.sql from the sample export and loads it into a throwaway
# database with the real migrations applied, then checks what landed.
#
#   migration/firebase/test/sql-load.sh                # temporary local cluster
#   DATABASE_URL=postgres://... migration/firebase/test/sql-load.sh   # existing empty database
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/migration/firebase"
OUT="$(mktemp -d)"
PSQL=(psql -v ON_ERROR_STOP=1 -q -X -At)

cleanup() { rm -rf "$OUT"; }
trap 'cleanup' EXIT

if [[ -z "${DATABASE_URL:-}" ]]; then
  PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl | tail -1)")}"
  TMP="$(mktemp -d)"
  PORT="${PGPORT_TEST:-54330}"
  RUN_AS=()
  if [[ "$(id -u)" == "0" ]]; then
    chown -R postgres "$TMP"
    RUN_AS=(runuser -u postgres --)
  fi
  "${RUN_AS[@]}" "$PG_BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
  "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
  cleanup() { "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP" "$OUT"; }
  DATABASE_URL="postgresql://postgres@/postgres?host=$TMP&port=$PORT"
fi

"${PSQL[@]}" "$DATABASE_URL" -o /dev/null -f "$ROOT/supabase/tests/supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  "${PSQL[@]}" "$DATABASE_URL" -o /dev/null -f "$f"
done

node "$HERE/cli.mjs" --input "$HERE/fixtures/sample-export.json" --agents "$HERE/fixtures/agents.json" --out "$OUT" >/dev/null

fail() { echo "FAIL: $*" >&2; exit 1; }
q() { "${PSQL[@]}" "$DATABASE_URL" -c "$1"; }

if grep -q "FIXTURE-SECRET" "$OUT"/*; then fail "a /users value leaked into the output"; fi

check() {
  local got
  got="$(q "$2")"
  [[ "$got" == "$3" ]] || fail "$1: expected '$3', got '$got'"
  echo "ok - $1"
}

# An agent who calls themselves Admin never takes the old admin login's work.
q "insert into auth.users (email, raw_user_meta_data) values ('agent-admin@example.com', '{\"full_name\": \"Admin\"}')" >/dev/null

# Refuses to run before the agents who own leads have accounts, and writes nothing.
if "${PSQL[@]}" "$DATABASE_URL" -f "$OUT/import.sql" >/dev/null 2>"$OUT/err"; then fail "import ran without agent accounts"; fi
grep -q "Agents without a web account: Neha (4 leads): no web account with email neha@example.com; Amit Kumar (1 leads): no web account with this full name; Admin: no admin account is named Admin and there are 0 active admin accounts" "$OUT/err" \
  || fail "unexpected error: $(cat "$OUT/err")"
check "nothing written on failure" "select count(*) from public.leads" "0"
check "trigger left enabled after failure" "select tgenabled from pg_trigger where tgname = 'leads_track_assignment'" "O"
not_ok="$("${PSQL[@]}" "$DATABASE_URL" -F '|' -f "$OUT/check.sql" | awk -F'|' '$3 != "ok"' | wc -l)"
[[ "$not_ok" == "3" ]] || fail "check.sql should report 3 problems before accounts exist, got $not_ok"
echo "ok - check.sql reports the missing accounts"
admin_row="$("${PSQL[@]}" "$DATABASE_URL" -F '|' -f "$OUT/check.sql" | awk -F'|' '$2 ~ /^Agent Admin/ {print $3 "|" $4}')"
[[ "$admin_row" == '0 active admin accounts|map Admin to one admin email in agents.json, e.g. {"Admin": "<admin email>"}, and regenerate' ]] \
  || fail "check.sql Admin row: '$admin_row'"
echo "ok - check.sql explains the Admin mapping"

# Two accounts with the same name are ambiguous, never guessed.
q "insert into auth.users (email, raw_user_meta_data) values ('amit1@example.com', '{\"full_name\": \"Amit  Kumar\"}'), ('amit2@example.com', '{\"full_name\": \"amit kumar\"}')" >/dev/null
if "${PSQL[@]}" "$DATABASE_URL" -f "$OUT/import.sql" >/dev/null 2>"$OUT/err"; then fail "import ran with an ambiguous agent name"; fi
grep -q "Amit Kumar (1 leads): several web accounts have this name" "$OUT/err" || fail "unexpected error: $(cat "$OUT/err")"
echo "ok - ambiguous names stop the import"
q "delete from auth.users where email = 'amit2@example.com'" >/dev/null

q "insert into auth.users (email, raw_user_meta_data) values ('neha@example.com', '{\"full_name\": \"Neha Sharma\"}'), ('admin@example.com', '{\"full_name\": \"Ash\"}')" >/dev/null
q "update public.profiles set role = 'ADMIN' where email = 'admin@example.com'" >/dev/null

not_ok="$("${PSQL[@]}" "$DATABASE_URL" -F '|' -f "$OUT/check.sql" | awk -F'|' '$3 != "ok"' | wc -l)"
[[ "$not_ok" == "0" ]] || fail "check.sql still reports problems: $("${PSQL[@]}" "$DATABASE_URL" -F '|' -f "$OUT/check.sql")"
echo "ok - check.sql is all ok once accounts exist"

"${PSQL[@]}" "$DATABASE_URL" -o /dev/null -f "$OUT/import.sql"

check "lead count" "select count(*) from public.leads" "7"
check "statuses mapped" \
  "select string_agg(client_name || '=' || status, ',' order by id) from public.leads" \
  "Renee Systems Pvt Ltd=Follow-up,renee systems=Follow-up,Kaveri Textiles=Closed Won,Ganga Motors=Prospect,Old Renewal Co=Active Client,Jan First Ltd=Prospect,Chiranjeevi=Prospect"
check "created_at kept" "select created_at = to_timestamp(1790000000) from public.leads where client_name = 'Renee Systems Pvt Ltd'" "t"
check "agent matched by full name" \
  "select p.email from public.leads l join public.profiles p on p.id = l.assigned_agent_id where l.client_name = 'Renee Systems Pvt Ltd'" \
  "amit1@example.com"
check "agent matched by email" \
  "select p.email from public.leads l join public.profiles p on p.id = l.assigned_agent_id where l.client_name = 'renee systems'" \
  "neha@example.com"
check "agent mapped to null is unassigned" "select assigned_agent_id is null from public.leads where client_name = 'Ganga Motors'" "t"
check "assignment time is the original creation time" \
  "select bool_and(assigned_at = created_at) from public.leads where assigned_agent_id is not null" "t"
check "unassigned leads have no assignment time" "select bool_and(assigned_at is null) from public.leads where assigned_agent_id is null" "t"
check "assignment trigger re-enabled" "select tgenabled from pg_trigger where tgname = 'leads_track_assignment'" "O"
check "designation kept" "select poc_designation from public.leads where client_name = 'Renee Systems Pvt Ltd'" "Director"
check "default designation" "select poc_designation from public.leads where client_name = 'renee systems'" "poc"
check "second Renee flagged duplicate" \
  "select string_agg(client_name || '=' || is_duplicate, ',' order by id) from public.leads where client_name ilike 'renee%'" \
  "Renee Systems Pvt Ltd=false,renee systems=true"
check "duplicate label names the agent" "select duplicate_label from public.leads where client_name = 'renee systems'" \
  "Duplicate: Already being processed by agent(s) [Amit  Kumar]"
check "notes split into lead_notes" \
  "select string_agg(agent_name || '/' || (agent_id is not null) || ': ' || content, ' | ' order by created_at) from public.lead_notes" \
  "Amit  Kumar/true: Called Rajesh, asked for quote | Ash/true: Please prioritise"
check "note time is IST" "select min(created_at) = '2026-10-02 14:05+05:30'::timestamptz from public.lead_notes" "t"
check "imported notes start out read for everyone" "select count(*) from public.lead_note_reads" "8"
check "free text stays in notes" "select notes from public.leads where client_name = 'Renee Systems Pvt Ltd'" "Met at the expo."
check "renewal milestones regenerated" \
  "select count(*) from public.events where is_system_generated and lead_id = (select id from public.leads where client_name = 'Renee Systems Pvt Ltd')" \
  "10"
check "hand-made events imported" \
  "select string_agg(title || '@' || to_char(event_timestamp at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') || '/' || is_completed, ',' order by id) from public.events where not is_system_generated" \
  "Site visit@2026-10-20 15:00/false,Team meeting@2026-10-22 10:00/true,call Hathnoora SI@2026-11-05 10:00/false,Kaveri visit@2026-11-06 11:00/false"
check "old admin's event goes to the admin account" \
  "select p.email from public.events e join public.profiles p on p.id = e.assigned_agent_id where e.title = 'call Hathnoora SI'" "admin@example.com"
check "event on a skipped copy follows the kept lead" \
  "select l.client_name from public.events e join public.leads l on l.id = e.lead_id where e.title = 'Kaveri visit'" "Kaveri Textiles"
check "renewal date recovered from the old calendar" "select renewal_date || '/' || (select count(*) from public.events e where e.lead_id = l.id and e.is_system_generated) from public.leads l where client_name = 'Jan First Ltd'" "2027-01-01/10"
check "calendar entry for an overwritten client kept in notes" \
  "select notes like '%Old calendar entry for this record: \"Renewal due: Awaze pvt Ltd (Health)\" on 2026-08-07 (POC: Chiranjeevi (9154230981). Agent: Neha.)%' and (length(notes) - length(replace(notes, 'Awaze', ''))) / 5 = 1 from public.leads where client_name = 'Chiranjeevi'" "t"
check "long-past due task imported as done on its due date" \
  "select is_completed and completed_at = event_timestamp from public.events e join public.leads l on l.id = e.lead_id where l.client_name = 'Old Renewal Co' and e.milestone = 'DUE'" "t"
check "future due task left open" \
  "select is_completed from public.events e join public.leads l on l.id = e.lead_id where l.client_name = 'Renee Systems Pvt Ltd' and e.milestone = 'DUE'" "f"
check "quote in name survives" "select poc_name from public.leads where client_name = 'Kaveri Textiles'" "O'Brien"
check "no reminder is due straight away" "select public.deliver_due_reminders()" "0"

after="$("${PSQL[@]}" "$DATABASE_URL" -F '|' -f "$OUT/check.sql" | awk -F'|' '$2 == "Import status" {print $3}')"
[[ "$after" == "already imported" ]] || fail "check.sql should report the import, got '$after'"
echo "ok - check.sql reports the finished import"

if "${PSQL[@]}" "$DATABASE_URL" -f "$OUT/import.sql" >/dev/null 2>"$OUT/err"; then fail "import ran twice"; fi
grep -q "already been imported" "$OUT/err" || fail "unexpected error on re-run: $(cat "$OUT/err")"
check "re-run changed nothing" "select count(*) from public.leads" "7"
check "marker records what was created" \
  "select jsonb_array_length(value -> 'lead_ids') || '/' || jsonb_array_length(value -> 'event_ids') from public.app_settings where key = 'firebase_import'" "7/4"

# undo.sql removes exactly the import, and only before anyone has worked on it.
q "insert into public.leads (client_name) values ('Walk-in Co')" >/dev/null
q "insert into public.lead_notes (lead_id, content) select id, 'Called back' from public.leads where client_name = 'Kaveri Textiles'" >/dev/null
if "${PSQL[@]}" "$DATABASE_URL" -f "$HERE/undo.sql" >/dev/null 2>"$OUT/err"; then fail "undo ran after work on the imported leads"; fi
grep -q "0 leads edited, 1 notes added, 0 calendar events added or changed" "$OUT/err" || fail "unexpected undo error: $(cat "$OUT/err")"
echo "ok - undo refuses once people have worked on the import"
q "delete from public.lead_notes where content = 'Called back'" >/dev/null
"${PSQL[@]}" "$DATABASE_URL" -o /dev/null -f "$OUT/undo.sql" 2>"$OUT/err" || fail "undo failed: $(cat "$OUT/err")"
grep -q "Removed 7 imported leads and 4 imported calendar events" "$OUT/err" || fail "unexpected undo output: $(cat "$OUT/err")"
check "undo keeps other leads" "select string_agg(client_name, ',') from public.leads" "Walk-in Co"
check "undo removes notes, events and the marker" \
  "select (select count(*) from public.lead_notes) || '/' || (select count(*) from public.events) || '/' || (select count(*) from public.app_settings where key = 'firebase_import')" "0/0/0"

# Data that tries to break out of the generated SQL stays data, and check.sql's
# suggested fix for a missing account is runnable as written.
cat >"$OUT/crafted.json" <<JSON
{"leads": {"x": {"id": "9\\n\\\\! touch $OUT/pwned\\ndrop table public.leads; --\\u2028select 1", "clientName": "Crafted Co \$firebase_import\$ \$\$", "status": "Prospect", "assignedAgent": "Ravi D'Souza", "createdAt": 1790000000000}}}
JSON
mkdir -p "$OUT/crafted"
node "$HERE/cli.mjs" --input "$OUT/crafted.json" --out "$OUT/crafted" >/dev/null
q "insert into auth.users (email, raw_user_meta_data) values ('dsouza@example.com', '{}')" >/dev/null
hint="$("${PSQL[@]}" "$DATABASE_URL" -F '|' -f "$OUT/crafted/check.sql" | awk -F'|' '$2 ~ /^Agent Ravi/ {print $4}')"
[[ "$hint" == "create an account, then: update public.profiles set full_name = 'Ravi D''Souza' where email = '<their login email>'" ]] \
  || fail "unexpected hint: '$hint'"
q "$(sed "s/<their login email>/dsouza@example.com/" <<<"${hint#create an account, then: }")" >/dev/null
check "suggested name fix maps the agent" \
  "select count(*) from public.profiles where full_name = 'Ravi D''Souza'" "1"
"${PSQL[@]}" "$DATABASE_URL" -o /dev/null -f "$OUT/crafted/import.sql" 2>"$OUT/err" || fail "crafted import failed: $(cat "$OUT/err")"
[[ ! -e "$OUT/pwned" ]] || fail "a shell command in the data ran"
check "crafted id is stored as data" \
  "select client_name || ' by ' || p.full_name from public.leads l join public.profiles p on p.id = l.assigned_agent_id where l.client_name like 'Crafted Co%'" \
  'Crafted Co $firebase_import$ $$ by Ravi D'"'"'Souza'
"${PSQL[@]}" "$DATABASE_URL" -o /dev/null -f "$HERE/undo.sql" 2>/dev/null

# After an undo the import can run again.
"${PSQL[@]}" "$DATABASE_URL" -o /dev/null -f "$OUT/import.sql"
check "re-import after undo" \
  "select (select count(*) from public.leads) || '/' || (select count(*) from public.lead_notes) || '/' || (select count(*) from public.events where not is_system_generated)" "8/2/4"

echo "All Firebase import checks passed"
