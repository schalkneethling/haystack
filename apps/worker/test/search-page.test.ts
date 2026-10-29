// The search page at `/` (#206), with the `search-enabled` flag on (#235). The browser tests
// answer /api/search with a stub (e2e/search-answers.ts), so these check what the Worker serves
// itself: the page, and that the real route answers no search until #214. search-switch.test.ts
// checks the flag off.
import { SEARCH_QUERY_CAP } from "@haystack/schemas";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { SEARCH_ENABLED_FLAG } from "../src/flags.ts";
import { SENSITIVE_NOTICE } from "../src/notices.ts";
import { mainContent } from "./main-content.ts";
import { seedSignedInUser, type SeededUser } from "./seed.ts";
import { createTestWorker } from "./test-worker.ts";
import { expectValidHtml } from "./validate-html.ts";

const server = createTestWorker({
  vars: { ALLOWED_EMAILS: "owner@example.com" },
  flags: { [SEARCH_ENABLED_FLAG]: true },
});
let origin: string;

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
});

let owner: SeededUser;

beforeEach(async () => {
  const DB = (await server.getWorker().getEnv()).DB;
  await DB.batch([DB.prepare("DELETE FROM sessions"), DB.prepare("DELETE FROM users")]);
  owner = await seedSignedInUser(DB, "owner@example.com");
});

async function searchPage(): Promise<string> {
  const response = await server.fetch("/", {
    headers: { accept: "text/html", cookie: owner.cookie },
    redirect: "manual",
  });
  expect(response.status).toBe(200);
  return response.text();
}

describe("GET /", () => {
  it("is the search page, with the field's label as its heading", async () => {
    const markup = await searchPage();
    expect(markup).toContain("<title>Search - Haystack</title>");
    expect(markup).toContain('<h1><label for="search-query">Search your saved links</label></h1>');
    await expectValidHtml(markup);
  });

  it("has a search landmark holding the form, the hint, the field and the button", async () => {
    const main = mainContent(await searchPage());
    expect(main).toMatch(
      /<search>\s*<form class="panel search-form" method="get" action="\/" data-search-form>/,
    );
    expect(main).toContain(
      '<p id="search-hint" class="hint">Describe what you\'re looking for in your own words.</p>',
    );
    expect(main).toContain('<button class="button button-primary" type="submit">Search</button>');
  });

  // The field has no name, so the form sends nothing without JavaScript, and its visible label
  // has no placeholder standing in for it.
  it("caps the field at the shared query cap, and gives it no name and no placeholder", async () => {
    const main = mainContent(await searchPage());
    expect(main).toContain(
      `<input id="search-query" class="search-input" type="search" maxlength="${SEARCH_QUERY_CAP}" aria-describedby="search-hint">`,
    );
    expect(SEARCH_QUERY_CAP).toBe(500);
    expect(main).not.toMatch(/placeholder|name="/);
  });

  // The script hides it, so it is shown without JavaScript, and when the script fails to load.
  it("says that searching needs JavaScript, and links to the saved links", async () => {
    expect(mainContent(await searchPage())).toContain(
      '<p id="search-needs-script" class="callout">Searching needs JavaScript, which isn\'t running in this browser. <a href="/saved-links">Go to your saved links</a> to browse them instead.</p>',
    );
  });

  it("shows the notice about private links", async () => {
    expect(mainContent(await searchPage())).toContain(SENSITIVE_NOTICE.toString());
  });

  // The script fills both. The live region is in the page from the start, so a screen reader
  // announces what the script writes to it.
  it("has an empty live region and an empty, hidden results list", async () => {
    const main = mainContent(await searchPage());
    expect(main).toContain('<div id="list-status" class="status" role="status"></div>');
    expect(main).toContain('<ol id="search-results" class="cards" hidden></ol>');
  });

  it("loads one module script, which imports the delete dialog's", async () => {
    const markup = await searchPage();
    expect([...markup.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0])).toEqual([
      '<script type="module" src="/assets/search.js">',
    ]);
    const script = await server.fetch("/assets/search.js");
    expect(await script.text()).toContain('import "./delete-dialog.js";');
  });

  it("marks Search as the current page, and not Saved links", async () => {
    const markup = await searchPage();
    expect(markup).toContain('<a class="nav-link" href="/" aria-current="page">Search</a>');
    expect(markup).toContain('<a class="nav-link" href="/saved-links">Saved links</a>');
  });

  it("answers HEAD like GET", async () => {
    const response = await server.fetch("/", {
      method: "HEAD",
      headers: { accept: "text/html", cookie: owner.cookie },
    });
    expect(response.status).toBe(200);
  });

  it("redirects to sign-in without a session, and returns to the search page", async () => {
    const response = await server.fetch("/", {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/sign-in?return_to=%2F");
  });
});

// The page's script asks for JSON, as a script must (plan, "Site sign-in"), so it gets a status
// it can act on rather than a redirect.
describe("POST /api/search, until #214", () => {
  function postSearch(headers: Record<string, string>) {
    return server.fetch("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify({ query: "a tool for testing" }),
      redirect: "manual",
    });
  }

  it("answers 401 without a session, which the page calls signed out", async () => {
    expect((await postSearch({ origin })).status).toBe(401);
  });

  // So a deploy before the real route cannot show results that no search produced.
  it("answers 404 with a session, so no search is made", async () => {
    expect((await postSearch({ origin, cookie: owner.cookie })).status).toBe(404);
  });

  it("rejects a request from another site", async () => {
    const response = await postSearch({ origin: "https://evil.example", cookie: owner.cookie });
    expect(response.status).toBe(403);
  });
});
