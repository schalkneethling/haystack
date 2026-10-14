// VoiceOver tests: Guidepup drives VoiceOver on macOS and records what it says. They need a Mac
// set up for VoiceOver automation (`voiceover:setup`, `voiceover:install`) and a headed
// browser, and VoiceOver takes over the machine while they run, so they are not part of
// `vp run quality`. See "Testing strategy" in plans/haystack-v1-implementation-plan.md.
import { screenReaderConfig } from "@guidepup/playwright";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  // One test at a time and headed, because there is only one VoiceOver and it cannot read a
  // headless browser.
  ...screenReaderConfig,
  testDir: "./e2e",
  testMatch: "**/*.voiceover.ts",
  // Each test starts VoiceOver and moves it into the page, which takes tens of seconds.
  timeout: 5 * 60 * 1000,
  // VoiceOver sometimes fails to start ("Unable to activate application"). In the trial runs,
  // the next test in the same job started it normally, so a retry absorbs that. Playwright
  // reports a test that passed on retry as flaky.
  retries: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { ...screenReaderConfig.use, trace: "retain-on-failure", video: "retain-on-failure" },
  // Playwright's WebKit, the closest Playwright browser to Safari.
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"], headless: false } }],
});
