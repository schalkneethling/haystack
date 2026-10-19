// A Worker per Playwright worker process, started with Wrangler's test harness and migrated.
// Tests navigate with relative paths: `baseURL` is that Worker's origin. The extension's browser
// tests start the Worker through `startHaystackWorker`, which this package exports.
//
// The Worker starts with the page fixture (test/page-fixture.ts), which answers every request the
// Worker makes, such as the address form's lookup (#105), with the pages a test registers, and
// fails any other. So no test, here or in the extension's suite, makes a request to the internet
// through the Worker. `pages` gives a test the fixture, and fails the test if the Worker made a
// request the test did not plan for.
import { type BrowserContext, expect, test as base } from "@playwright/test";
import { createTestHarness } from "wrangler";
import { type PageFixture, startPageFixture } from "../test/page-fixture.ts";
import { seedSignedInUser } from "../test/seed.ts";

const SIGNED_IN_EMAIL = "e2e@example.com";

/** A cookie that signs the seeded user in, split into the parts a cookie API takes. */
export interface SessionCookie {
  name: string;
  value: string;
}

export interface HaystackWorker {
  origin: string;
  /** Seeds a signed-in user and returns their session cookie. */
  createSession(): Promise<SessionCookie>;
  /** Seeds a signed-in user and gives the browser context their session. */
  signIn(context: BrowserContext): Promise<void>;
  /** Runs a read query against the Worker's D1, for checking what a flow stored. */
  query(sql: string, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  /** The pages the Worker can fetch, and the requests it made. */
  pages: PageFixture;
  /**
   * Stops the Worker and the page fixture. Throws when the Worker made a request that no test
   * planned for, so a suite that does not check after each test still fails.
   */
  close(): Promise<void>;
}

// seedSignedInUser returns a Cookie header with a single `name=value` pair.
function parseCookieHeader(header: string): SessionCookie {
  const separator = header.indexOf("=");
  if (separator <= 0) {
    throw new Error("The seeded session is not a name=value cookie");
  }
  return { name: header.slice(0, separator), value: header.slice(separator + 1) };
}

/** Starts the Worker in the local Workers runtime, applies the migrations, and serves it. */
export async function startHaystackWorker(): Promise<HaystackWorker> {
  // Before the harness, so that the Worker's first request is already answered here.
  const pages = startPageFixture();
  const server = createTestHarness({
    workers: [
      {
        configPath: new URL("../wrangler.jsonc", import.meta.url),
        vars: { ALLOWED_EMAILS: SIGNED_IN_EMAIL },
      },
    ],
  });
  const stop = async () => {
    await server.close();
    pages.close();
  };
  try {
    const { url } = await server.listen();
    // Playwright's request API calls the Worker from this process, through what MSW patches.
    pages.allow(url.origin);
    const worker = server.getWorker();
    await worker.applyD1Migrations("DB");
    const db = (await worker.getEnv()).DB;
    return {
      origin: url.origin,
      createSession: async () => {
        const { cookie } = await seedSignedInUser(db, SIGNED_IN_EMAIL);
        return parseCookieHeader(cookie);
      },
      signIn: async (context) => {
        const { cookie } = await seedSignedInUser(db, SIGNED_IN_EMAIL);
        // The session is a real cookie, with the attributes the Worker sets. Playwright's extra
        // HTTP headers were used before, but Chromium does not send them on the GET that follows
        // a 303, which the address form's lookup ends with (#105). A __Host- cookie needs
        // Secure, which addCookies sets only with a domain and path: from an http: `url` it
        // would clear it. The extension's tests add theirs the same way.
        const { name, value } = parseCookieHeader(cookie);
        await context.addCookies([
          {
            name,
            value,
            domain: url.hostname,
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
      },
      query: async (sql, ...values) =>
        (
          await db
            .prepare(sql)
            .bind(...values)
            .all()
        ).results,
      pages,
      close: async () => {
        await stop();
        if (pages.unplanned.length > 0) {
          throw new Error(
            `The Worker requested addresses no test planned for: ${pages.unplanned.join(", ")}`,
          );
        }
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export const test = base.extend<
  { signIn: () => Promise<void>; query: HaystackWorker["query"]; pages: PageFixture },
  { haystackWorker: HaystackWorker }
>({
  // Automatic, so every test starts with no routes, and fails on a request it did not plan for,
  // whether or not it registers pages.
  pages: [
    async ({ haystackWorker }, use) => {
      haystackWorker.pages.reset();
      await use(haystackWorker.pages);
      expect(haystackWorker.pages.unplanned).toEqual([]);
    },
    { auto: true },
  ],
  haystackWorker: [
    // Playwright reads fixture dependencies from this destructuring pattern, so it must be one.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const worker = await startHaystackWorker();
      try {
        await use(worker);
      } finally {
        await worker.close();
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
