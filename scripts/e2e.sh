#!/usr/bin/env bash
# Runs the end-to-end tests against the local Supabase stack.
#   npx supabase start          # once
#   npm run test:e2e            # resets the local database, builds, tests
# Set E2E_SKIP_BUILD=1 to reuse an existing build.
set -euo pipefail
cd "$(dirname "$0")/.."

eval "$(npx supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|PUBLISHABLE_KEY|SECRET_KEY)=')"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="${PUBLISHABLE_KEY:-$ANON_KEY}"
export SUPABASE_SECRET_KEY="${SECRET_KEY:-$SERVICE_ROLE_KEY}"
# The app must run without Gemini: AI features fall back to the offline rules.
export GEMINI_API_KEY=""

npx supabase db reset --local --no-seed >/dev/null
if [[ -z "${E2E_SKIP_BUILD:-}" ]]; then
  npx next build
fi
npx playwright test "$@"
