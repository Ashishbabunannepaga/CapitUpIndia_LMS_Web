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

# Refuses to run before the agents who own leads have accounts, and writes nothing.
if "${PSQL[@]}" "$DATABASE_URL" -f "$OUT/import.sql" >/dev/null 2>"$OUT/err"; then fail "import ran without agent accounts"; fi
grep -q "Agents without a web account: Amit Kumar (1 leads): no web account with this full name; Neha (1 leads): no web account with email neha@example.com" "$OUT/err" \
  || fail "unexpected error: $(cat "$OUT/err")"
check "nothing written on failure" "select count(*) from public.leads" "0"
check "trigger left enabled after failure" "select tgenabled from pg_trigger where tgname = 'leads_track_assignment'" "O"
not_ok="$("${PSQL[@]}" "$DATABASE_URL" -F '|' -f "$OUT/check.sql" | awk -F'|' '$3 != "ok"' | wc -l)"
[[ "$not_ok" == "2" ]] || fail "check.sql should report 2 problems before accounts exist, got $not_ok"
echo "ok - check.sql reports both missing accounts"

# Two accounts with the same name are ambiguous, never guessed.
q "insert into auth.users (email, raw_user_meta_data) values ('amit1@example.com', '{\"full_name\": \"Amit  Kumar\"}'), ('amit2@example.com', '{\"full_name\": \"amit kumar\"}')" >/dev/null
if "${PSQL[@]}" "$DATABASE_URL" -f "$OUT/import.sql" >/dev/null 2>"$OUT/err"; then fail "import ran with an ambiguous agent name"; fi
grep -q "Amit Kumar (1 leads): several web accounts have this name" "$OUT/err" || fail "unexpected error: $(cat "$OUT/err")"
echo "ok - ambiguous names stop the import"
q "delete from auth.users where email = 'amit2@example.com'" >/dev/null

q "insert into auth.users (email, raw_user_meta_data) values ('neha@example.com', '{\"full_name\": \"Neha Sharma\"}'), ('admin@example.com', '{\"full_name\": \"Ash\"}')" >/dev/null

not_ok="$("${PSQL[@]}" "$DATABASE_URL" -F '|' -f "$OUT/check.sql" | awk -F'|' '$3 != "ok"' | wc -l)"
[[ "$not_ok" == "0" ]] || fail "check.sql still reports problems: $("${PSQL[@]}" "$DATABASE_URL" -F '|' -f "$OUT/check.sql")"
echo "ok - check.sql is all ok once accounts exist"

"${PSQL[@]}" "$DATABASE_URL" -o /dev/null -f "$OUT/import.sql"

check "lead count" "select count(*) from public.leads" "4"
check "statuses mapped" \
  "select string_agg(client_name || '=' || status, ',' order by id) from public.leads" \
  "Renee Systems Pvt Ltd=Follow-up,renee systems=Follow-up,Kaveri Textiles=Closed Won,Ganga Motors=Prospect"
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
  "Amit  Kumar/true: Called Rajesh, asked for quote | Admin/false: Please prioritise"
check "note time is IST" "select min(created_at) = '2026-10-02 14:05+05:30'::timestamptz from public.lead_notes" "t"
check "imported notes start out read for everyone" "select count(*) from public.lead_note_reads" "6"
check "free text stays in notes" "select notes from public.leads where client_name = 'Renee Systems Pvt Ltd'" "Met at the expo."
check "renewal milestones regenerated" \
  "select count(*) from public.events where is_system_generated and lead_id = (select id from public.leads where client_name = 'Renee Systems Pvt Ltd')" \
  "10"
check "hand-made events imported" \
  "select string_agg(title || '@' || to_char(event_timestamp at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') || '/' || is_completed, ',' order by id) from public.events where not is_system_generated" \
  "Site visit@2026-10-20 15:00/false,Team meeting@2026-10-22 10:00/true"
check "quote in name survives" "select poc_name from public.leads where client_name = 'Kaveri Textiles'" "O'Brien"
check "no reminder is due straight away" "select public.deliver_due_reminders()" "0"

after="$("${PSQL[@]}" "$DATABASE_URL" -F '|' -f "$OUT/check.sql" | awk -F'|' '$2 == "Import status" {print $3}')"
[[ "$after" == "already imported" ]] || fail "check.sql should report the import, got '$after'"
echo "ok - check.sql reports the finished import"

if "${PSQL[@]}" "$DATABASE_URL" -f "$OUT/import.sql" >/dev/null 2>"$OUT/err"; then fail "import ran twice"; fi
grep -q "already been imported" "$OUT/err" || fail "unexpected error on re-run: $(cat "$OUT/err")"
check "re-run changed nothing" "select count(*) from public.leads" "4"

echo "All Firebase import checks passed"
