// A Worker per Playwright worker process, started with Wrangler's test harness and migrated.
// Tests navigate with relative paths: `baseURL` is that Worker's origin. The extension's browser
// tests start the Worker through `startHaystackWorker`, which this package exports.
//
// The Worker starts with the page fixture (test/page-fixture.ts), which answers every request the
// Worker makes, such as the address form's lookup (#105), with the pages a test registers, and
// fails any other. So no test, here or in the extension's suite, makes a request to the internet
// through the Worker. `pages` gives a test the fixture, and fails the test if the Worker made a
// request the test did not plan for.
//
// Jev, which the save form asks whether a link looks private (#132), is answered through the
// same fixture, at JEV_ORIGIN under the reserved `.test` domain, with a test key. Every test
// starts with Jev answering DEFAULT_NOUL, far below the threshold, so the save form shows no
// warning unless a test asks for one with `jev`.
import { type BrowserContext, expect, type Page, test as base } from "@playwright/test";
import { createTestHarness } from "wrangler";
import { noul } from "../test/jev-answers.ts";
import { JEV_ORIGIN, status, SYSTEM_ONE_URL } from "../test/jev-fixture.ts";
import { type PageFixture, startPageFixture } from "../test/page-fixture.ts";
import { seedSignedInUser } from "../test/seed.ts";

const SIGNED_IN_EMAIL = "e2e@example.com";

/** Not a real key: the Jev client only checks that one is set. */
const TYPESAFE_TEST_KEY = "ts-e2e-key-6c2f90ab";

/** Jev's answer at the start of every test, below SENSITIVE_WARN_THRESHOLD in wrangler.jsonc. */
const DEFAULT_NOUL = 0.05;

/** How Jev answers the Worker's sensitivity question, from the next request on. */
export interface JevAnswers {
  /**
   * Answers with these nouls, one per request, in order. The last one answers every request
   * after it.
   */
  noul(...values: [number, ...number[]]): void;
  /** Answers every request with a 503, as an outage would. */
  unavailable(): void;
}

function jevAnswers(pages: PageFixture): JevAnswers {
  return {
    noul: (...values) => {
      const queue = [...values];
      pages.route(SYSTEM_ONE_URL, (request) => {
        const value = queue.length > 1 ? queue.shift() : queue[0];
        return noul(value ?? DEFAULT_NOUL)(request);
      });
    },
    unavailable: () => {
      pages.route(SYSTEM_ONE_URL, status(503));
    },
  };
}

/**
 * How the browser carries the seeded session to the Worker, which runs on http://127.0.0.1.
 *
 * - `cookie`: a real cookie, with the attributes the Worker sets (`__Host-`, `Secure`). Chromium
 *   treats a loopback address as secure and sends it, on every request, including the GET after
 *   a 303, which the address form's lookup ends with (#105).
 * - `header`: a `Cookie` header that Playwright adds to every request (`setExtraHTTPHeaders`).
 *   Chromium leaves it off the GET after a 303, so it cannot carry the session through the
 *   lookup. WebKit keeps it there.
 *
 * WebKit gets the header, because whether it sends a `Secure` cookie to http://127.0.0.1 depends
 * on the macOS it runs on, which Playwright's WebKit on macOS takes its networking from. On macOS
 * 27, headless and headed WebKit (Playwright's build 2370) sent the cookie. On the macOS 26 CI
 * runner the same build did not, and every VoiceOver test was sent to Google's sign-in (#107).
 * The production cookie is unchanged; only how the tests hand it to the browser differs.
 */
type SessionTransport = "cookie" | "header";

function sessionTransport(browserName: string): SessionTransport {
  return browserName === "chromium" ? "cookie" : "header";
}

/**
 * Checks that the browser sends a session the Worker accepts, and fails at once if it does not.
 * Without the check, a browser with no session is sent to sign-in and on to Google, and the test
 * waits minutes for a field that never appears.
 *
 * The check never navigates to a page that needs a session, because Playwright's routes do not
 * see the hops of a redirect, so the redirect to Google could not be stopped. It loads the
 * signed-out page, which looks up no session, and asks for `/` with the page's own `fetch`. The
 * browser sends the session with it as with any request, and the Worker answers a request that
 * is not for a page with 401 when it has no session, instead of a redirect to sign-in.
 */
export async function expectSignedIn(page: Page): Promise<void> {
  await page.goto("/auth/signed-out");
  const status = await page.evaluate(async () => (await fetch("/")).status);
  expect(status, "signIn gave the browser a session the Worker accepts").toBe(200);
}

/** A cookie that signs the seeded user in, split into the parts a cookie API takes. */
export interface SessionCookie {
  name: string;
  value: string;
}

export interface HaystackWorker {
  origin: string;
  /** Seeds a signed-in user and returns their session cookie. */
  createSession(): Promise<SessionCookie>;
  /**
   * Seeds a signed-in user and gives the browser context their session, the way that browser
   * carries it (`SessionTransport`). `browserName` is Playwright's.
   */
  signIn(context: BrowserContext, browserName: string): Promise<void>;
  /** Runs a read query against the Worker's D1, for checking what a flow stored. */
  query(sql: string, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  /**
   * Runs a statement that changes the Worker's D1, for putting a bookmark in a state that no
   * browser flow reaches, such as Held or Failed, which only the sweep sets.
   */
  run(sql: string, ...values: unknown[]): Promise<void>;
  /** The pages the Worker can fetch, and the requests it made. */
  pages: PageFixture;
  /**
   * Forgets the pages' routes and requests, and has Jev answer DEFAULT_NOUL again. Each test
   * starts with it.
   */
  reset(): void;
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
        vars: { ALLOWED_EMAILS: SIGNED_IN_EMAIL, JEV_BASE_URL: JEV_ORIGIN },
        secrets: { TYPESAFE_API_KEY: TYPESAFE_TEST_KEY },
      },
    ],
  });
  jevAnswers(pages).noul(DEFAULT_NOUL);
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
      signIn: async (context, browserName) => {
        const { cookie } = await seedSignedInUser(db, SIGNED_IN_EMAIL);
        if (sessionTransport(browserName) === "header") {
          await context.setExtraHTTPHeaders({ cookie });
          return;
        }
        // A __Host- cookie needs Secure, which addCookies sets only with a domain and path: from
        // an http: `url` it would clear it. The extension's tests add theirs the same way.
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
      run: async (sql, ...values) => {
        await db
          .prepare(sql)
          .bind(...values)
          .run();
      },
      pages,
      reset: () => {
        pages.reset();
        jevAnswers(pages).noul(DEFAULT_NOUL);
      },
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
  {
    signIn: () => Promise<void>;
    signOut: () => Promise<void>;
    query: HaystackWorker["query"];
    run: HaystackWorker["run"];
    pages: PageFixture;
    jev: JevAnswers;
  },
  { haystackWorker: HaystackWorker }
>({
  // Automatic, so every test starts with no routes but Jev's default answer, and fails on a
  // request it did not plan for, whether or not it registers pages.
  pages: [
    async ({ haystackWorker }, use) => {
      haystackWorker.reset();
      await use(haystackWorker.pages);
      expect(haystackWorker.pages.unplanned).toEqual([]);
    },
    { auto: true },
  ],
  // After `pages`, which sets the default answer, so a test's own answer is the one that holds.
  jev: async ({ pages }, use) => {
    await use(jevAnswers(pages));
  },
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
  // Signs in, then checks it worked, so a session the browser does not send fails here, at once,
  // and not minutes later at a field that never appears.
  signIn: async ({ context, page, haystackWorker, browserName }, use) => {
    await use(async () => {
      await haystackWorker.signIn(context, browserName);
      await expectSignedIn(page);
    });
  },
  // Takes the session away from the browser, whichever way signIn gave it.
  signOut: async ({ context }, use) => {
    await use(async () => {
      await context.clearCookies();
      await context.setExtraHTTPHeaders({});
    });
  },
  query: async ({ haystackWorker }, use) => {
    await use((sql, ...values) => haystackWorker.query(sql, ...values));
  },
  run: async ({ haystackWorker }, use) => {
    await use((sql, ...values) => haystackWorker.run(sql, ...values));
  },
});

export { expect } from "@playwright/test";
