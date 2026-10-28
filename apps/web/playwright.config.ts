import { defineConfig, devices } from "@playwright/test";

/*
 * End-to-end tests against a running web app (port 4100) backed by the local anonymous Convex
 * deployment with MAIL_TRANSPORT=log. See README "End-to-end tests" for the exact setup; the tests
 * read verification links from the Convex log file named by E2E_CONVEX_LOG.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4100",
    trace: "retain-on-failure",
    colorScheme: "dark",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
