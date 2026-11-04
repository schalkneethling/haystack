// VoiceOver tests: Guidepup drives VoiceOver on macOS and records what it says. They need a Mac
// set up for VoiceOver automation (`voiceover:setup`, `voiceover:install`) and a headed
// browser, and VoiceOver takes over the machine while they run, so they are not part of
// `vp run quality`. See "Testing strategy" in plans/haystack-v1-implementation-plan.md.
//
// Guidepup's `screenReaderConfig` is written out below instead of imported: importing
// `@guidepup/playwright` throws on Linux, where no screen reader is available, and knip loads
// this config there to find the tests.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  // One test at a time and headed, because there is only one VoiceOver and it cannot read a
  // headless browser.
  workers: 1,
  fullyParallel: false,
  testDir: "./e2e",
  testMatch: "**/*.voiceover.ts",
  // Each test starts VoiceOver and moves it into the page, which takes tens of seconds.
  timeout: 5 * 60 * 1000,
  // VoiceOver sometimes fails to start ("Unable to activate application"). In the trial runs,
  // the next test in the same job started it normally, so a retry absorbs that. Playwright
  // reports a test that passed on retry as flaky.
  retries: 1,
  // CI passes --forbid-only and --reporter=list,github, so this file needs no Node globals: the
  // pre-commit check type-checks it on its own, without Node's types.
  reporter: "list",
  use: { trace: "retain-on-failure", video: "retain-on-failure" },
  // Playwright's WebKit, the closest Playwright browser to Safari. The sign-in check runs first,
  // in the same WebKit on the same Mac, without VoiceOver, and the VoiceOver tests depend on it,
  // so a session the browser does not send fails in seconds rather than in every test (#107).
  projects: [
    {
      name: "webkit-session",
      testMatch: "**/session.e2e.ts",
      use: { ...devices["Desktop Safari"], headless: false },
    },
    {
      name: "webkit",
      dependencies: ["webkit-session"],
      use: { ...devices["Desktop Safari"], headless: false },
    },
  ],
});
