// The search page at `/` (#206), with the `search-enabled` flag on (#235). The browser tests
// answer /api/search with a stub (e2e/search-answers.ts), so these check what the Worker serves
// itself: the page, and that the real route answers no search until #214. search-switch.test.ts
// checks the flag off. A delete from a result returns here (#208); the dialog that deletes in
// place is checked in the browser, in e2e/search-delete.e2e.ts.
import { normalizeUrl, SEARCH_QUERY_CAP } from "@haystack/schemas";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { SEARCH_ENABLED_FLAG } from "../src/flags.ts";
import { SENSITIVE_NOTICE } from "../src/notices.ts";
import { mainContent } from "./main-content.ts";
import { seedBookmark, seedSignedInUser, type SeededUser } from "./seed.ts";
import { createTestWorker } from "./test-worker.ts";
import { expectValidHtml } from "./validate-html.ts";

const server = createTestWorker({
  vars: { ALLOWED_EMAILS: "owner@example.com, second@example.com" },
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
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
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
    // The ID is the saved links page's, so the delete dialog moves focus to it when the last
    // result is deleted (#208).
    expect(markup).toContain(
      '<h1 id="list-heading"><label for="search-query">Search your saved links</label></h1>',
    );
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
    expect(main).not.toContain("placeholder");
    // The search landmark only: the card template's Delete form has a named field (#208).
    const search = main.slice(main.indexOf("<search>"), main.indexOf("</search>"));
    expect(search).not.toContain('name="');
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
  // announces what the script writes to it. The delete dialog shows the empty state after the
  // last result is deleted (#208).
  it("has an empty live region, an empty, hidden results list and a hidden empty state", async () => {
    const main = mainContent(await searchPage());
    expect(main).toContain('<div id="list-status" class="status" role="status"></div>');
    expect(main).toContain(
      '<h2 id="results-heading" class="list-heading" hidden>Results</h2>\n      <ol id="search-results" class="cards" aria-labelledby="results-heading" hidden></ol>',
    );
    expect(main).toContain(
      '<p id="empty-state" class="empty-state" hidden>You deleted every link this search found. Search again to find others.</p>',
    );
  });

  // search.js builds each result from the saved links page's card (design review), so the card's
  // markup has one source, with a Delete form that returns to the search page.
  it("has the saved links page's card as a template for the results", async () => {
    const main = mainContent(await searchPage());
    const template = /<template id="bookmark-card-template">([\s\S]*?)<\/template>/.exec(main)?.[1];
    expect(template).toBeDefined();
    expect(template).toContain('<p class="card-date">Saved <time datetime=');
    expect(template).toContain(
      '<h3 id="title-template"><a href="https://example.com/" rel="noreferrer">Title</a></h3>',
    );
    expect(template).toContain('<p class="address">https://example.com/</p>');
    expect(template).toContain('<p class="card-description">Description</p>');
    expect(template).toContain('<input type="hidden" name="return_to" value="/">');
    // search.js finds the Delete form and its button by these.
    expect(template).toContain("data-delete-form>");
    expect(template).toContain(
      '<button class="button button-small button-danger-outline" type="submit" id="delete-template"',
    );
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

// A result's Delete form, which search.js builds, names the search page as the page to return to
// (#208). Without the dialog, the button leads to the confirmation page, which passes it on.
describe("POST /bookmarks/:id/delete from a search result", () => {
  const url = "https://example.com/guide";
  let bookmarkId: string;

  beforeEach(async () => {
    const DB = (await server.getWorker().getEnv()).DB;
    bookmarkId = await seedBookmark(DB, owner.userId, url, normalizeUrl(url), { title: "A guide" });
  });

  function postDelete(
    id: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) {
    return server.fetch(`/bookmarks/${encodeURIComponent(id)}/delete`, {
      method: "POST",
      headers: { origin, cookie: owner.cookie, ...headers },
      body: new URLSearchParams({ return_to: "/", ...fields }),
      redirect: "manual",
    });
  }

  async function bookmarkIds(): Promise<unknown[]> {
    const DB = (await server.getWorker().getEnv()).DB;
    const { results } = await DB.prepare("SELECT id FROM bookmarks ORDER BY id").all();
    return results.map((row: { id: unknown }) => row.id);
  }

  it("shows the confirmation page, which returns to the search page", async () => {
    const response = await postDelete(bookmarkId, {});
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<h1>Delete this link?</h1>");
    expect(markup).toContain(
      `<p><strong>Address:</strong> <span class="address">${url}</span></p>`,
    );
    expect(markup).toContain('<input type="hidden" name="return_to" value="/">');
    // The results exist only in the page that searched, so "Keep it" goes to the search page.
    expect(markup).toContain('<a href="/">Keep it and go back to search</a>');
    await expectValidHtml(markup);
    expect(await bookmarkIds()).toEqual([bookmarkId]);
  });

  it("deletes when confirmed, and shows the search page saying what was deleted", async () => {
    const response = await postDelete(bookmarkId, { confirm: "yes" });
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<title>Deleted “A guide” - Search - Haystack</title>");
    expect(markup).toContain('<a class="nav-link" href="/" aria-current="page">Search</a>');
    const main = mainContent(markup);
    expect(main).toContain(
      '<div id="list-status" class="status" role="status"><p>Deleted “A guide”.</p></div>',
    );
    // No results, because showing them again would mean searching again, and the empty state
    // stays hidden, because it is for a search whose results were all deleted in the page.
    expect(main).toContain(
      '<h2 id="results-heading" class="list-heading" hidden>Results</h2>\n      <ol id="search-results" class="cards" aria-labelledby="results-heading" hidden></ol>',
    );
    expect(main).toContain('<p id="empty-state" class="empty-state" hidden>');
    await expectValidHtml(markup);
    expect(await bookmarkIds()).toEqual([]);
  });

  it("answers a second confirmation, as a reload sends, with the 404 page", async () => {
    await postDelete(bookmarkId, { confirm: "yes" });
    const response = await postDelete(bookmarkId, { confirm: "yes" });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("<h1>This link isn't in your saved links</h1>");
  });

  it.each([
    ["not yet confirmed", {}],
    ["confirmed", { confirm: "yes" }],
  ])("returns 404 for another user's bookmark, %s, and deletes nothing", async (_, fields) => {
    const DB = (await server.getWorker().getEnv()).DB;
    const second = await seedSignedInUser(DB, "second@example.com");
    const theirs = await seedBookmark(DB, second.userId, url, normalizeUrl(url), {
      title: "Their guide",
    });
    const response = await postDelete(theirs, fields);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Their guide");
    expect(await bookmarkIds()).toEqual([bookmarkId, theirs].toSorted());
  });

  // A POST can't be repeated by returning to its path, so sign-in returns to the page the delete
  // started from, as it does for /held (#34).
  it("sends a submission without a session through sign-in, back to the search page", async () => {
    const response = await postDelete(
      bookmarkId,
      { confirm: "yes" },
      { cookie: "", accept: "text/html,application/xhtml+xml" },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/auth/sign-in?return_to=%2F");
    expect(await bookmarkIds()).toEqual([bookmarkId]);
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
