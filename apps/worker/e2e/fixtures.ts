// A Worker per Playwright worker process, started with Wrangler's test harness and migrated.
// Tests navigate with relative paths: `baseURL` is that Worker's origin. The extension's browser
// tests start the Worker through `startHaystackWorker`, which this package exports.
import { type BrowserContext, test as base } from "@playwright/test";
import { createTestHarness } from "wrangler";
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
  /** Stops the Worker. */
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
    return {
      origin: url.origin,
      createSession: async () => {
        const { cookie } = await seedSignedInUser(db, SIGNED_IN_EMAIL);
        return parseCookieHeader(cookie);
      },
      signIn: async (context) => {
        const { cookie } = await seedSignedInUser(db, SIGNED_IN_EMAIL);
        // The session travels as a request header. addCookies with an http: `url` clears
        // Secure, which a __Host- cookie needs, so Chromium refuses it (a domain and path work,
        // as the extension's tests show). Real cookie handling is covered by the sign-in flow,
        // not by these page tests.
        await context.setExtraHTTPHeaders({ cookie });
      },
      query: async (sql, ...values) =>
        (
          await db
            .prepare(sql)
            .bind(...values)
            .all()
        ).results,
      close: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

export const test = base.extend<
  { signIn: () => Promise<void>; query: HaystackWorker["query"] },
  { haystackWorker: HaystackWorker }
>({
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
