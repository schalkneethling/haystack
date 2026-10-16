// Browser tests for the extension in Chromium. Each test worker starts the Worker with the
// Worker's test harness and builds the extension against its origin (e2e/fixtures.ts), so no dev
// server or secrets are needed.
import { defineConfig } from "@playwright/test";

// Playwright attaches to the popup only when told to treat Chromium's "other" targets as pages:
// the popup's target has that type when it starts. Without it, a test can trigger the popup but
// never see it. The variable is read by Playwright's Chromium code (crBrowser), not documented.
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";

export default defineConfig({
  testDir: "./e2e",
  // `.e2e.ts`, so `vp test` (Vitest) does not pick these up.
  testMatch: "**/*.e2e.ts",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  // The fixtures launch their own persistent Chromium context with the extension loaded.
  projects: [{ name: "chromium" }],
});
