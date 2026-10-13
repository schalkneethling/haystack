// A Worker per Playwright worker process, started with Wrangler's test harness and migrated.
// Tests navigate with relative paths: `baseURL` is that Worker's origin.
import { test as base } from "@playwright/test";
import { createTestHarness } from "wrangler";

export const test = base.extend<object, { workerOrigin: string }>({
  workerOrigin: [
    // Playwright reads fixture dependencies from this destructuring pattern, so it must be one.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = createTestHarness({
        workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
      });
      const { url } = await server.listen();
      try {
        await server.getWorker().applyD1Migrations("DB");
        await use(url.origin);
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ workerOrigin }, use) => {
    await use(workerOrigin);
  },
});

export { expect } from "@playwright/test";
