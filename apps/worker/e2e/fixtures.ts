// A Worker per Playwright worker process, started with Wrangler's test harness and migrated.
// Tests navigate with relative paths: `baseURL` is that Worker's origin.
import { type BrowserContext, test as base } from "@playwright/test";
import { createTestHarness } from "wrangler";
import { seedSignedInUser } from "../test/seed.ts";

const SIGNED_IN_EMAIL = "e2e@example.com";

interface HaystackWorker {
  origin: string;
  /** Seeds a signed-in user and gives the browser context their session. */
  signIn(context: BrowserContext): Promise<void>;
  /** Runs a read query against the Worker's D1, for checking what a flow stored. */
  query(sql: string, ...values: unknown[]): Promise<Record<string, unknown>[]>;
}

export const test = base.extend<
  { signIn: () => Promise<void>; query: HaystackWorker["query"] },
  { haystackWorker: HaystackWorker }
>({
  haystackWorker: [
    // Playwright reads fixture dependencies from this destructuring pattern, so it must be one.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = createTestHarness({
        workers: [
          {
            configPath: new URL("../wrangler.jsonc", import.meta.url),
            vars: { ALLOWED_EMAILS: SIGNED_IN_EMAIL },
          },
        ],
      });
      const { url } = await server.listen();
      try {
        const worker = server.getWorker();
        await worker.applyD1Migrations("DB");
        const db = (await worker.getEnv()).DB;
        await use({
          origin: url.origin,
          signIn: async (context) => {
            const { cookie } = await seedSignedInUser(db, SIGNED_IN_EMAIL);
            // Chromium refuses to add a Secure __Host- cookie for an http: origin through
            // addCookies, so the session travels as a request header instead. Real cookie
            // handling is covered by the sign-in flow, not by these page tests.
            await context.setExtraHTTPHeaders({ cookie });
          },
          query: async (sql, ...values) =>
            (
              await db
                .prepare(sql)
                .bind(...values)
                .all()
            ).results,
        });
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ haystackWorker }, use) => {
    await use(haystackWorker.origin);
  },
  signIn: async ({ context, haystackWorker }, use) => {
    await use(() => haystackWorker.signIn(context));
  },
  query: async ({ haystackWorker }, use) => {
    await use((sql, ...values) => haystackWorker.query(sql, ...values));
  },
});

export { expect } from "@playwright/test";
