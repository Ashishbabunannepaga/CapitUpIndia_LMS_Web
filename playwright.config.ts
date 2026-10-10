import { defineConfig, devices } from "@playwright/test";

import { AUTH_SECRET, BASE_URL, PORT } from "./e2e/fixtures";

// End-to-end tests against the built Worker (`npm run cf:build`) running
// under `wrangler dev` with a local D1 and R2. Run with `npm run test:e2e`,
// which resets the local database and builds first (scripts/e2e.sh).

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: [
      `npx wrangler dev --ip 127.0.0.1 --port ${PORT} --test-scheduled --show-interactive-dev-session=false`,
      `--var BETTER_AUTH_SECRET:${AUTH_SECRET} --var BETTER_AUTH_URL:${BASE_URL}`,
      // The app must run without Gemini: AI features fall back to the offline rules.
      `--var GEMINI_API_KEY:`,
    ].join(" "),
    url: `${BASE_URL}/login`,
    // The tests and the Worker share the local database; the server's own
    // Node must not get the test runner's react-server condition.
    env: { NODE_OPTIONS: "" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
