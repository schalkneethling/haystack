// Recording which search result a person follows (#215). The page sends the record with
// `navigator.sendBeacon` when a result's link is followed, so the request has to outlive the page
// that sent it. These tests search through the Worker's own /api/search, because a record is only
// accepted for an answer that a real run logged, and follow the links to an address that the
// browser is given a page for (`stubSavedPages`), so no request leaves the machine. The
// endpoint's own checks (404 for another user's run, 401, 403, idempotence) are in
// apps/worker/test/search-click.test.ts. The design's checks, axe and the 320 px width, are in
// design.e2e.ts, and the Tab order of the results in search.e2e.ts.
import type { Page, Request } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { SYSTEM_ONE_URL } from "../test/jev-fixture.ts";
import type { PageFixture } from "../test/page-fixture.ts";
import {
  answerBy,
  clearCollection,
  type EnrichedBookmark,
  seedEnriched,
  signedInUserId,
} from "./search-collection.ts";
import { SAVED_AT, SEARCH_STATUS } from "./search-answers.ts";

test.beforeEach(async ({ signIn, run }) => {
  await signIn();
  await clearCollection(run);
});

const SAVED_PAGE = "Saved page";

const COLLECTION: readonly EnrichedBookmark[] = [
  {
    title: "Vitest browser mode guide",
    description: "Run tests in a real browser.",
    matchText: "best",
    createdAt: SAVED_AT,
  },
  { title: "Playwright locators", matchText: "next", createdAt: SAVED_AT + 1_000 },
  { title: "A bread recipe", matchText: "below", createdAt: SAVED_AT + 2_000 },
];

/**
 * The saved links are at example.com, which the browser is given a page for, whatever its path.
 * The route is the context's, so a tab that a link opens has it too. Returns the addresses that
 * were asked for, in order, which shows that a link opened a tab even though Playwright does not
 * report a tab that a middle click opens in the background.
 */
async function stubSavedPages(page: Page): Promise<string[]> {
  const visited: string[] = [];
  await page.context().route("https://example.com/**", (route) => {
    visited.push(route.request().url());
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>${SAVED_PAGE}</title><h1>${SAVED_PAGE}</h1>`,
    });
  });
  return visited;
}

function field(page: Page) {
  return page.getByRole("searchbox", { name: "Search your saved links" });
}

function status(page: Page) {
  return page.getByRole("status").and(page.locator(SEARCH_STATUS));
}

/** The link of the result with this title. */
function link(page: Page, title: string) {
  return page.getByRole("link", { name: title });
}

const FOUND = "2 saved links match your search.";

/** What a test needs to search the collection, and to look at what the page recorded. */
interface Fixtures {
  readonly page: Page;
  readonly pages: PageFixture;
  readonly run: Parameters<typeof clearCollection>[0];
  readonly query: Parameters<typeof signedInUserId>[0];
}

/**
 * Saves the collection, has Jev rank the first two bookmarks above both thresholds and the third
 * below them, and searches, so the page shows two results. Returns the bookmarks' IDs, in the
 * collection's order.
 */
async function searchCollection({
  page,
  pages,
  run,
  query,
}: Fixtures): Promise<string[] & { visited: string[] }> {
  const ids = await seedEnriched(run, await signedInUserId(query), "click", COLLECTION);
  pages.route(
    SYSTEM_ONE_URL,
    answerBy({ best: { noul: 0.95, score: 2.9 }, next: { noul: 0.7, score: 1.8 } }),
  );
  const visited = await stubSavedPages(page);
  await page.goto("/");
  await searchFor(page, "testing in a browser");
  return Object.assign(ids, { visited });
}

async function searchFor(page: Page, text: string): Promise<void> {
  await field(page).fill(text);
  await field(page).press("Enter");
  await expect(status(page)).toHaveText(FOUND);
}

/** The IDs of the bookmarks whose answers are clicked, in no order the tests rely on. */
async function clickedIds(query: Fixtures["query"]): Promise<string[]> {
  const rows = await query("SELECT bookmark_id FROM search_answers WHERE clicked = 1");
  return rows.map((row) => String(row.bookmark_id)).sort();
}

/** Every request the page makes to the endpoint, with its body, as it is made. */
function recordRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/search/click") {
      requests.push(request);
    }
  });
  return requests;
}

test("following a result with a click records it for that answer and no other, and the page opens", async ({
  page,
  pages,
  run,
  query,
}) => {
  const [, next, below] = await searchCollection({ page, pages, run, query });
  const requests = recordRequests(page);
  const runs = await query("SELECT id FROM search_runs");

  await link(page, "Playwright locators").click();

  await expect(page).toHaveTitle(SAVED_PAGE);
  await expect.poll(() => clickedIds(query)).toEqual([next]);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method()).toBe("POST");
  expect(requests[0]?.postDataJSON()).toEqual({ runId: String(runs[0]?.id), bookmarkId: next });
  // The answer for a bookmark below the thresholds exists and was not shown, and is untouched.
  expect(await query("SELECT clicked FROM search_answers WHERE bookmark_id = ?", below)).toEqual([
    { clicked: 0 },
  ]);
});

test("Enter on a result's link records it", async ({ page, pages, run, query }) => {
  const [best] = await searchCollection({ page, pages, run, query });

  await link(page, "Vitest browser mode guide").focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveTitle(SAVED_PAGE);
  await expect.poll(() => clickedIds(query)).toEqual([best]);
});

test("a middle click, which opens a new tab and leaves the results, records it", async ({
  page,
  pages,
  run,
  query,
}) => {
  const ids = await searchCollection({ page, pages, run, query });
  const [best] = ids;

  await link(page, "Vitest browser mode guide").click({ button: "middle" });

  await expect.poll(() => ids.visited).toEqual(["https://example.com/click-0"]);
  await expect.poll(() => clickedIds(query)).toEqual([best]);
  // The search page stays as it was.
  await expect(status(page)).toHaveText(FOUND);
});

test("Ctrl+click, which also opens a new tab, records it", async ({ page, pages, run, query }) => {
  const ids = await searchCollection({ page, pages, run, query });
  const [best] = ids;

  await link(page, "Vitest browser mode guide").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => ids.visited).toEqual(["https://example.com/click-0"]);

  await expect.poll(() => clickedIds(query)).toEqual([best]);
  await expect(status(page)).toHaveText(FOUND);
});

test("a result is recorded against the search that showed it, not the latest", async ({
  page,
  pages,
  run,
  query,
}) => {
  const [best] = await searchCollection({ page, pages, run, query });
  // A second search: the results of the first are replaced, and each result carries its own run.
  await searchFor(page, "a second search");
  const runs = await query("SELECT id FROM search_runs ORDER BY created_at DESC, rowid DESC");
  expect(runs).toHaveLength(2);
  const requests = recordRequests(page);

  await link(page, "Vitest browser mode guide").click();

  await expect.poll(() => clickedIds(query)).toEqual([best]);
  expect(requests[0]?.postDataJSON()).toEqual({ runId: String(runs[0]?.id), bookmarkId: best });
  expect(
    await query("SELECT clicked FROM search_answers WHERE search_run_id = ?", String(runs[1]?.id)),
  ).toEqual([{ clicked: 0 }, { clicked: 0 }, { clicked: 0 }]);
});

test("a click on the card outside its link, and on Delete, records nothing", async ({
  page,
  pages,
  run,
  query,
}) => {
  await searchCollection({ page, pages, run, query });
  const requests = recordRequests(page);
  const card = page.locator("#search-results > li").first();

  await card.locator(".address").click();
  await card.getByRole("button", { name: /^Delete/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await link(page, "Vitest browser mode guide").click({ button: "right" });
  await page.keyboard.press("Escape");

  // A request is recorded when it is made, and a click makes it synchronously, so none is
  // waiting to be made.
  expect(requests).toEqual([]);
  expect(await clickedIds(query)).toEqual([]);
});

test("the record is sent without holding up the visit: the saved page opens while it is held, and the record still arrives", async ({
  page,
  pages,
  run,
  query,
}) => {
  const [best] = await searchCollection({ page, pages, run, query });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route("**/api/search/click", async (route) => {
    held = true;
    await released;
    await route.continue();
  });

  await link(page, "Vitest browser mode guide").click();

  // The page that sent the record is gone, and the record has not reached the Worker.
  await expect(page).toHaveTitle(SAVED_PAGE);
  await expect.poll(() => held).toBe(true);
  expect(await clickedIds(query)).toEqual([]);

  release();
  await expect.poll(() => clickedIds(query)).toEqual([best]);
});

test("a record that fails does not break the link", async ({ page, pages, run, query }) => {
  await searchCollection({ page, pages, run, query });
  await page.route("**/api/search/click", (route) => route.abort("failed"));

  await link(page, "Vitest browser mode guide").click();

  await expect(page).toHaveTitle(SAVED_PAGE);
  expect(await clickedIds(query)).toEqual([]);
});

test("a record that is answered with an error does not break the link", async ({
  page,
  pages,
  run,
  query,
}) => {
  await searchCollection({ page, pages, run, query });
  await page.route("**/api/search/click", (route) => route.fulfill({ status: 500 }));

  await link(page, "Vitest browser mode guide").click();

  await expect(page).toHaveTitle(SAVED_PAGE);
});

test("a browser whose sendBeacon throws does not break the link", async ({
  page,
  pages,
  run,
  query,
}) => {
  await page.addInitScript(() => {
    navigator.sendBeacon = () => {
      throw new Error("blocked");
    };
  });
  await searchCollection({ page, pages, run, query });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await link(page, "Vitest browser mode guide").click();

  await expect(page).toHaveTitle(SAVED_PAGE);
  expect(errors).toEqual([]);
});

test("a browser with no sendBeacon does not break the link either", async ({
  page,
  pages,
  run,
  query,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "sendBeacon", { value: undefined });
  });
  await searchCollection({ page, pages, run, query });

  await link(page, "Vitest browser mode guide").click();

  await expect(page).toHaveTitle(SAVED_PAGE);
});

test("nothing changes for the person: the link keeps rel=noreferrer and the card has no new tab stop", async ({
  page,
  pages,
  run,
  query,
}) => {
  await searchCollection({ page, pages, run, query });
  const card = page.locator("#search-results > li").first();

  await expect(link(page, "Vitest browser mode guide")).toHaveAttribute("rel", "noreferrer");
  await expect(card.locator("a[href]")).toHaveCount(1);
  await expect(card.locator("[tabindex]")).toHaveCount(0);
  // The card's two controls, its link and Delete, are the only ones that Tab can reach. The
  // Delete form's hidden field is not a control.
  await expect(
    card.locator("a[href], button, input:not([type=hidden]), select, textarea, [tabindex]"),
  ).toHaveCount(2);
});
