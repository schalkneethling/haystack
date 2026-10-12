// Browser tests for the pages the Worker renders. Each test worker starts the Worker with
// Wrangler's test harness (e2e/fixtures.ts), the same way the integration tests do, so no dev
// server or secrets are needed.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // `.e2e.ts`, so `vp test` (Vitest) does not pick these up.
  testMatch: "**/*.e2e.ts",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
