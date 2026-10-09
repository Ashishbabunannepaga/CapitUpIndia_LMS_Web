#!/usr/bin/env bash
# Runs the end-to-end tests against the built Worker with a fresh local D1.
#   npm run test:e2e            # resets the local database, builds, tests
# Set E2E_SKIP_BUILD=1 to reuse an existing build.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf .wrangler/state
npx wrangler d1 migrations apply DB --local >/dev/null
if [[ -z "${E2E_SKIP_BUILD:-}" ]]; then
  npm run cf:build
fi
# The tests import the data layer to set up accounts and check results; its
# modules are marked server-only, which resolves to a no-op under this condition.
NODE_OPTIONS="--conditions=react-server" npx playwright test "$@"
