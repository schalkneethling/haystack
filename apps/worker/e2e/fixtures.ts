// A Worker per Playwright worker process, started with Wrangler's test harness and migrated.
import { test as base } from "@playwright/test";
import { createTestHarness } from "wrangler";

interface Haystack {
  /** The origin the Worker listens on, for example http://127.0.0.1:61234. */
  origin: string;
  url(path: string): string;
}

export const test = base.extend<object, { haystack: Haystack }>({
  haystack: [
    // Playwright reads fixture dependencies from this destructuring pattern, so it must be one.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = createTestHarness({
        workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
      });
      const { url } = await server.listen();
      await server.getWorker().applyD1Migrations("DB");
      await use({ origin: url.origin, url: (path) => new URL(path, url).href });
      await server.close();
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
