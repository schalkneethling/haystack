// The search page at `/` (#206): typed search, its results and the live region that counts them,
// against answers stubbed in the browser (search-answers.ts). The design's checks, axe and the
// 320 px width, are in design.e2e.ts with the other pages'.
import { isHttpsUrl } from "@haystack/schemas";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import {
  answerSearches,
  SEARCH_MESSAGES,
  SEARCH_STATUS,
  searchAnswer,
  type StubbedResult,
} from "./search-answers.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

const GUIDES: readonly StubbedResult[] = [
  { title: "Vitest browser mode guide", description: "Run tests in a real browser." },
  { title: "Playwright locators", description: null },
];

const NEEDS_SCRIPT = "Searching needs JavaScript, which isn't running in this browser.";

function field(page: Page) {
  return page.getByRole("searchbox", { name: "Search your saved links" });
}

function status(page: Page) {
  return page.getByRole("status").and(page.locator(SEARCH_STATUS));
}

function results(page: Page) {
  return page.locator("#search-results > li");
}

test("the page works with the keyboard alone, and focus stays in the field", async ({ page }) => {
  await answerSearches(page, () => GUIDES);
  await page.goto("/");
  // The header's four stops come first, then the field and the button.
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const control of [
    page.getByRole("link", { name: "Haystack", exact: true }),
    nav.getByRole("link", { name: "Search" }),
    nav.getByRole("link", { name: "Saved links" }),
    page.getByRole("button", { name: "Sign out" }),
    field(page),
    page.getByRole("button", { name: "Search", exact: true }),
  ]) {
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
  }
  await page.keyboard.press("Shift+Tab");
  await expect(field(page)).toBeFocused();
  await page.keyboard.type("testing in a browser");
  await page.keyboard.press("Enter");

  await expect(status(page)).toHaveText("2 saved links match your search.");
  await expect(results(page)).toHaveCount(2);
  // Focus is where the search was made, so the query can be changed and sent again.
  await expect(field(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Vitest browser mode guide" })).toBeFocused();
});

test("the message that searching needs JavaScript is hidden once the script runs", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText(NEEDS_SCRIPT)).toBeHidden();
});

test("pressing the button keeps focus on it", async ({ page }) => {
  await answerSearches(page, () => GUIDES);
  await page.goto("/");
  await field(page).fill("testing in a browser");
  const button = page.getByRole("button", { name: "Search", exact: true });
  await button.focus();
  await page.keyboard.press("Space");
  await expect(status(page)).toHaveText("2 saved links match your search.");
  await expect(button).toBeFocused();
});

test("the count is announced for one result, for several, and when nothing matches", async ({
  page,
}) => {
  const answers: Record<string, readonly StubbedResult[]> = {
    one: GUIDES.slice(0, 1),
    several: [...GUIDES, { title: "A third guide" }],
    none: [],
  };
  await answerSearches(page, (query) => answers[query] ?? []);
  await page.goto("/");

  await field(page).fill("one");
  await field(page).press("Enter");
  await expect(status(page)).toHaveText(SEARCH_MESSAGES.one);
  await expect(results(page)).toHaveCount(1);

  await field(page).fill("several");
  await field(page).press("Enter");
  await expect(status(page)).toHaveText("3 saved links match your search.");
  await expect(results(page)).toHaveCount(3);

  // Nothing matched is not an error: the message is in the status region, with no alert, and the
  // list of the search before is gone.
  await field(page).fill("none");
  await field(page).press("Enter");
  await expect(status(page)).toHaveText(SEARCH_MESSAGES.none);
  await expect(page.locator("#search-results")).toBeHidden();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the same count twice is written again, so it is announced again", async ({ page }) => {
  await answerSearches(page, () => GUIDES);
  await page.goto("/");
  await field(page).fill("testing");
  await field(page).press("Enter");
  await expect(status(page)).toHaveText("2 saved links match your search.");
  // The region is emptied when the search starts and written when its answer arrives, so the
  // message is a new paragraph, not the old one left in place.
  await page.locator(`${SEARCH_STATUS} > p`).evaluate((paragraph) => {
    paragraph.dataset.first = "yes";
  });
  await field(page).press("Enter");
  await expect(page.locator(`${SEARCH_STATUS} > p:not([data-first])`)).toHaveText(
    "2 saved links match your search.",
  );
  await expect(page.locator(`${SEARCH_STATUS} > p`)).toHaveCount(1);
});

test("a search posts the trimmed query as JSON, and puts nothing in the address", async ({
  page,
}) => {
  const requests = await answerSearches(page, () => GUIDES);
  await page.goto("/");
  await field(page).fill("  a tool for testing  ");
  await field(page).press("Enter");
  await expect(results(page)).toHaveCount(2);
  expect(requests).toHaveLength(1);
  const [{ request, body }] = requests as [(typeof requests)[number]];
  expect(request.method()).toBe("POST");
  expect(new URL(request.url()).search).toBe("");
  expect(await request.headerValue("content-type")).toBe("application/json");
  expect(await request.headerValue("accept")).toBe("application/json");
  expect(body).toEqual({ query: "a tool for testing" });
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe("/");
});

test("an empty query sends nothing and says what to do", async ({ page }) => {
  const requests = await answerSearches(page, () => GUIDES);
  await page.goto("/");
  await field(page).fill("   ");
  await field(page).press("Enter");
  await expect(status(page)).toHaveText(SEARCH_MESSAGES.empty);
  expect(requests).toHaveLength(0);
});

test("a result shows its title as a heading that wraps the link, then its description", async ({
  page,
}) => {
  await answerSearches(page, () => [
    {
      title: "A guide",
      description: "First line\nSecond line",
      url: "https://example.com/guide?page=2",
    },
    { title: "No description", description: null },
  ]);
  await page.goto("/");
  await field(page).fill("guide");
  await field(page).press("Enter");

  const first = results(page).first();
  await expect(first.getByRole("article")).toHaveCount(1);
  const heading = first.getByRole("heading", { level: 2, name: "A guide" });
  const link = heading.getByRole("link", { name: "A guide" });
  await expect(link).toHaveAttribute("href", "https://example.com/guide?page=2");
  await expect(link).toHaveAttribute("rel", "noreferrer");
  // The line break is kept, as on the saved links page.
  await expect(first.locator("p.card-description")).toHaveJSProperty(
    "innerHTML",
    "First line<br>Second line",
  );
  // The page shows the title and the description only: not the address, nor a date.
  await expect(first).not.toContainText("example.com");
  await expect(results(page).nth(1).locator("p")).toHaveCount(0);
  // The IDs the Delete control (#208) and the dialog need.
  const [id, titleId] = await first.evaluate((item) => [item.id, item.querySelector("h2")?.id]);
  expect(id).toMatch(/^bookmark-/);
  expect(titleId).toBe(`title-${id?.slice("bookmark-".length)}`);
});

test("bookmark text is shown as text, and never parsed as markup", async ({ page }) => {
  const markup = "<img src=x onerror=\"document.title='injected'\">";
  await answerSearches(page, () => [
    { title: `Title ${markup}`, description: `Description ${markup}` },
  ]);
  await page.goto("/");
  await field(page).fill("markup");
  await field(page).press("Enter");
  const item = results(page).first();
  await expect(item.getByRole("heading", { level: 2 })).toHaveText(`Title ${markup}`);
  await expect(item.locator("p.card-description")).toHaveText(`Description ${markup}`);
  await expect(page.locator("#search-results img")).toHaveCount(0);
  await expect(page).toHaveTitle("Search - Haystack");
});

// The page's rule is isHttpsUrl's, which the saved links page links by, so each address becomes
// a link exactly when isHttpsUrl passes it.
test("only an https address becomes a link", async ({ page }) => {
  const addresses = [
    "https://example.com/ok",
    "HTTPS://example.com/upper",
    "http://example.com/plain",
    "javascript:alert(1)",
    "data:text/html,<p>hi</p>",
    "https:example.com",
    "https://exa mple.com/",
    "/relative",
  ];
  await answerSearches(page, () =>
    addresses.map((url, index) => ({ title: `Result ${index}`, url })),
  );
  await page.goto("/");
  await field(page).fill("links");
  await field(page).press("Enter");
  await expect(results(page)).toHaveCount(addresses.length);
  for (const [index, url] of addresses.entries()) {
    const heading = results(page).nth(index).getByRole("heading", { level: 2 });
    await expect(heading).toHaveText(`Result ${index}`);
    await expect(heading.getByRole("link"), url).toHaveCount(isHttpsUrl(url) ? 1 : 0);
  }
});

test("a new search replaces the results of the one before", async ({ page }) => {
  await answerSearches(page, (query) => [{ title: `Found for ${query}` }]);
  await page.goto("/");
  await field(page).fill("first");
  await field(page).press("Enter");
  await expect(results(page)).toHaveText(["Found for first"]);
  await field(page).fill("second");
  await field(page).press("Enter");
  await expect(results(page)).toHaveText(["Found for second"]);
});

// A slow answer to a query that a newer search replaced must not show its results under the
// newer query. The test holds both answers, answers the newer first, then the older.
test("a late answer to a replaced query is ignored", async ({ page }) => {
  const held: Route[] = [];
  await page.route("**/api/search", (route) => {
    held.push(route);
  });
  await page.goto("/");
  const answer = (route: Route, results: readonly StubbedResult[]) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(searchAnswer(results)) });

  await field(page).fill("first");
  await field(page).press("Enter");
  await expect.poll(() => held.length).toBe(1);
  await field(page).fill("second");
  await field(page).press("Enter");
  await expect.poll(() => held.length).toBe(2);
  const [first, second] = held as [Route, Route];

  await answer(second, [{ title: "Found for second" }]);
  await expect(results(page)).toHaveText(["Found for second"]);
  await expect(status(page)).toHaveText(SEARCH_MESSAGES.one);

  await answer(first, [{ title: "Found for first" }, { title: "Also for first" }]);
  // The page has the late answer once the browser has read it. A task queued after that runs
  // after the script's handling of it.
  await (await first.request().response())?.finished();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(results(page)).toHaveText(["Found for second"]);
  await expect(status(page)).toHaveText(SEARCH_MESSAGES.one);
  await expect(field(page)).toHaveValue("second");
});

// The page puts a result's ID into element IDs, which an aria-labelledby list refers to (#208),
// so it checks the ID as the schema does. The stub's answers always pass the schema, so this
// answer is written by hand.
test("an answer whose result ID holds whitespace is a failure", async ({ page }) => {
  await page.route("**/api/search", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runId: "run-1",
        results: [{ id: "a b", title: "A guide", description: null, url: "https://example.com/" }],
      }),
    }),
  );
  await page.goto("/");
  await field(page).fill("guide");
  await field(page).press("Enter");
  await expect(status(page)).toHaveText(SEARCH_MESSAGES.failed);
  await expect(results(page)).toHaveCount(0);
});

// Until #214 the real route answers 404, which the page calls a failure, as it does a network
// error. The results of an earlier search go, because they would read as this search's.
test("a search that fails says so, and clears the earlier results", async ({ page }) => {
  let fail = false;
  await answerSearches(page, () => (fail ? { status: 500 } : GUIDES));
  await page.goto("/");
  await field(page).fill("testing");
  await field(page).press("Enter");
  await expect(results(page)).toHaveCount(2);
  fail = true;
  await field(page).press("Enter");
  await expect(status(page)).toHaveText(SEARCH_MESSAGES.failed);
  await expect(page.locator("#search-results")).toBeHidden();
  await expect(field(page)).toBeFocused();
});

test("a network error is a failure too", async ({ page }) => {
  await page.route("**/api/search", (route) => route.abort("failed"));
  await page.goto("/");
  await field(page).fill("testing");
  await field(page).press("Enter");
  await expect(status(page)).toHaveText(SEARCH_MESSAGES.failed);
});

// No stub: these reach the Worker's own route.
test.describe("against the Worker's own /api/search", () => {
  test("a search gets the 404 of a route that doesn't exist yet, as a failure", async ({
    page,
  }) => {
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    await expect(status(page)).toHaveText(SEARCH_MESSAGES.failed);
  });

  // The Worker answers a script's request without a session with 401, and the page says the
  // person is signed out, with a link that signs in and comes back here.
  test("a search after the session ended says so, with a link to sign in", async ({
    page,
    signOut,
  }) => {
    await page.goto("/");
    await signOut();
    await field(page).fill("testing");
    await field(page).press("Enter");
    await expect(status(page)).toHaveText(SEARCH_MESSAGES.signedOut);
    await expect(status(page).getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/auth/sign-in?return_to=%2F",
    );
    await expect(field(page)).toBeFocused();
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the page says searching needs JavaScript, and links to the saved links", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText(NEEDS_SCRIPT)).toBeVisible();
    await page.getByRole("link", { name: "Go to your saved links" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved links");
  });

  // The field has no name, so the form sends nothing, and the query reaches no address.
  test("pressing Search loads the page again, with no query in the address", async ({ page }) => {
    await page.goto("/");
    await field(page).fill("a private query");
    await field(page).press("Enter");
    await page.waitForLoadState("load");
    expect(new URL(page.url()).search).toBe("");
    await expect(page).toHaveTitle("Search - Haystack");
    expect(page.url()).not.toContain("private");
  });
});
