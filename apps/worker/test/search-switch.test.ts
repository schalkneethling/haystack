// The `search-enabled` flag (#235, src/flags.ts). Off, which is its default and what a Flagship
// outage gives, `/` sends a signed-in user on to the saved links, and the header has no Search
// link. On, `/` is the search page (search-page.test.ts), and every signed-in page's header links
// to it. The flag is set through the fake Flagship Worker that createTestWorker starts for
// `flags` (test-worker.ts), or left to Miniflare's simulator, which holds
// no flags, so the switch gives its default.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { SEARCH_ENABLED_FLAG } from "../src/flags.ts";
import { seedSignedInUser } from "./seed.ts";
import { createTestWorker, type TestWorker } from "./test-worker.ts";
import { expectValidHtml } from "./validate-html.ts";

const ALLOWED = { ALLOWED_EMAILS: "owner@example.com" };
const SEARCH_LINK = /<a class="nav-link" href="\/"[^>]*>Search<\/a>/;
// On the saved links page, its own link is marked as the current page.
const SAVED_LINKS_LINK =
  /<a class="nav-link" href="\/saved-links"( aria-current="page")?>Saved links<\/a>/;

// One Worker per state, each with its own signed-in user.
function signedInWorker(server: TestWorker) {
  let cookie = "";
  beforeAll(async () => {
    await server.listen();
    await server.getWorker().applyD1Migrations("DB");
    cookie = (await seedSignedInUser((await server.getWorker().getEnv()).DB, "owner@example.com"))
      .cookie;
  });
  afterAll(async () => {
    await server.close();
  });
  return (path: string, method = "GET") =>
    server.fetch(path, { method, headers: { accept: "text/html", cookie }, redirect: "manual" });
}

describe.each([
  ["without the flag, as the simulator has it", createTestWorker({ vars: ALLOWED })],
  [
    "with the flag off",
    createTestWorker({ vars: ALLOWED, flags: { [SEARCH_ENABLED_FLAG]: false } }),
  ],
  // The getter gives the default for a value of the wrong type, and the module checks it too.
  [
    "with a flag that isn't a boolean",
    createTestWorker({ vars: ALLOWED, flags: { [SEARCH_ENABLED_FLAG]: 1 } }),
  ],
])("search switched off, %s", (_, server) => {
  const get = signedInWorker(server);

  it.each(["GET", "HEAD"])(
    "answers %s / with a temporary redirect to the saved links, kept by no cache",
    async (method) => {
      const response = await get("/", method);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/saved-links");
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );

  it.each(["/saved-links", "/save", "/held", "/nowhere"])(
    "leaves the Search link out of the header of %s",
    async (path) => {
      const markup = await (await get(path)).text();
      expect(markup).toMatch(SAVED_LINKS_LINK);
      expect(markup).not.toMatch(SEARCH_LINK);
      // The wordmark links to `/` too, outside the navigation, and stays.
      expect(markup).toContain('<a class="wordmark" href="/">');
      await expectValidHtml(markup);
    },
  );
});

describe("search switched on", () => {
  const get = signedInWorker(
    createTestWorker({ vars: ALLOWED, flags: { [SEARCH_ENABLED_FLAG]: true } }),
  );

  it.each(["/saved-links", "/save", "/held", "/nowhere"])(
    "links the header of %s to the search page",
    async (path) => {
      const markup = await (await get(path)).text();
      expect(markup).toMatch(SEARCH_LINK);
      // The only guard for the navigation's whitespace, which withoutSearchLink depends on:
      // Search follows `<nav>` on the same line, so taking it out leaves no line of only spaces,
      // which html-validate rejects in the tests above.
      expect(markup).toContain(
        '<nav class="site-nav" aria-label="Main"><a class="nav-link" href="/">Search</a>\n            <a class="nav-link" href="/saved-links"',
      );
    },
  );

  it.each(["GET", "HEAD"])("answers %s / with the search page", async (method) => {
    const response = await get("/", method);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});
