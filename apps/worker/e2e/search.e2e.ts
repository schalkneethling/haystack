// The search page at `/` (#206): typed search, its results and the live region that counts them,
// and how a slow search, an incomplete one and a failed one look (#207), against answers stubbed
// in the browser (search-answers.ts). The design's checks, axe and the 320 px width, are in
// design.e2e.ts with the other pages'.
import { isHttpsUrl } from "@haystack/schemas";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { installPausedClock } from "./held-lookups.ts";
import {
  answerSearches,
  type HeldSearch,
  holdSearches,
  SAVED_AT,
  saveResults,
  SEARCH_MESSAGES,
  SEARCH_PROCESSING_LABEL,
  SEARCH_STATUS,
  type StubbedResult,
  TRY_AGAIN,
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

/** Each result's title, without the Delete button that follows it in the card (#208). */
function resultTitles(page: Page) {
  return results(page).getByRole("heading", { level: 2 });
}

/** The Search button with its own label, as it is when no search runs. */
function searchButton(page: Page) {
  return page.getByRole("button", { name: "Search", exact: true });
}

/**
 * The error state, in place of the results: the alert's box in the live region with `message`
 * and Try again, and no list, nor anything that says nothing matched.
 */
async function expectFailure(page: Page, message: string): Promise<void> {
  const alert = status(page).locator(".alert");
  await expect(alert.locator("p")).toHaveText(message);
  await expect(alert.getByRole("button", { name: TRY_AGAIN })).toBeVisible();
  await expect(page.locator("#search-results")).toBeHidden();
  await expect(status(page)).not.toContainText(SEARCH_MESSAGES.none);
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

test("a result shows the saved link's card: the date, the title as a link, the address, the description", async ({
  page,
}) => {
  await answerSearches(page, () => [
    {
      title: "A guide",
      description: "First line\nSecond line",
      url: "https://example.com/guide?page=2",
      createdAt: Date.UTC(2026, 9, 1, 23, 30),
    },
    { title: "No description", description: null },
  ]);
  await page.goto("/");
  await field(page).fill("guide");
  await field(page).press("Enter");

  const first = results(page).first();
  // The date in UTC, as the saved links page shows it, so 23:30 on 1 October is still that day.
  const time = first.locator("p.card-date time");
  await expect(first.locator("p.card-date")).toHaveText("Saved October 1, 2026");
  await expect(time).toHaveAttribute("datetime", "2026-10-01T23:30:00.000Z");
  const heading = first.getByRole("heading", { level: 2, name: "A guide" });
  const link = heading.getByRole("link", { name: "A guide" });
  await expect(link).toHaveAttribute("href", "https://example.com/guide?page=2");
  await expect(link).toHaveAttribute("rel", "noreferrer");
  await expect(first.locator("p.address")).toHaveText("https://example.com/guide?page=2");
  // The line break is kept, as on the saved links page.
  await expect(first.locator("p.card-description")).toHaveJSProperty(
    "innerHTML",
    "First line<br>Second line",
  );
  // A result without a description has no description paragraph, as on the saved links page.
  await expect(results(page).nth(1).locator("p.card-description")).toHaveCount(0);
  // The IDs the Delete control (#208) and the dialog need.
  const [id, titleId] = await first.evaluate((item) => [item.id, item.querySelector("h2")?.id]);
  expect(id).toMatch(/^bookmark-/);
  expect(titleId).toBe(`title-${id?.slice("bookmark-".length)}`);
});

// The two pages share one card (design review), built from bookmark-card.ts: on the saved links
// page by the Worker, and on the search page by search.js from the Worker's template. For the
// same bookmark, the two cards have the same elements, attributes and text, apart from the Delete
// form's field that returns a delete to the search page. One card has a description over two
// lines, which both sides split at line breaks, and the other an http address, which neither
// links.
test("a result's card is the saved links page's card for the same bookmark", async ({
  page,
  query,
}) => {
  const [described, plain] = await saveResults(page, query, "same-card", [
    "A described card",
    "A card without a link",
  ]);
  if (described === undefined || plain === undefined) {
    throw new Error("The bookmarks were not saved");
  }
  const description = "First line\nSecond line";
  const httpUrl = "http://example.com/same-card-plain";
  await query("UPDATE bookmarks SET description = ? WHERE id = ?", description, described.id);
  await query("UPDATE bookmarks SET url = ? WHERE id = ?", httpUrl, plain.id);
  const bookmarks = [
    { ...described, description },
    { ...plain, url: httpUrl },
  ];
  // The card as markup, with the whitespace between elements, which only the Worker's template
  // literals write, left out.
  const cardOf = (item: ReturnType<typeof results>) =>
    item.evaluate((element) => element.outerHTML.replace(/>\s+</g, "><"));
  const returnField = '<input type="hidden" name="return_to" value="/">';
  await page.goto("/saved-links");
  const onSavedLinks = await Promise.all(
    bookmarks.map(({ id }) => cardOf(page.locator(`#recent-saves > li#bookmark-${id}`))),
  );
  await answerSearches(page, () => bookmarks);
  await page.goto("/");
  await field(page).fill("the same cards");
  await field(page).press("Enter");
  await expect(results(page)).toHaveCount(2);
  for (const [index, card] of onSavedLinks.entries()) {
    const onSearch = await cardOf(results(page).nth(index));
    expect(onSearch).toContain(returnField);
    expect(onSearch.replace(returnField, "")).toBe(card);
  }
  expect(onSavedLinks[0]).toContain("First line<br>Second line");
  expect(onSavedLinks[1]).not.toContain("<a ");
});

// search.js builds a sample card before it enhances the page. A template that has drifted from
// what it expects would otherwise throw in the middle of a search, and leave the last query's
// results under the new one.
test("a card template that has drifted leaves the page saying it needs JavaScript", async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        '<p class="address">https://example.com/</p>',
        '<p class="link-address">https://example.com/</p>',
      );
      await route.fulfill({ response, body });
    },
  );
  await page.goto("/");
  await expect(page.locator("#search-needs-script")).toBeVisible();
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
  await expect(resultTitles(page)).toHaveText(["Found for first"]);
  await field(page).fill("second");
  await field(page).press("Enter");
  await expect(resultTitles(page)).toHaveText(["Found for second"]);
});

// A newer search aborts the one it replaces (see "while a search runs"), so the browser drops
// the replaced search's answer. An answer already on its way when the abort comes can still
// reach the script, which must ignore it too, and never show its results under the newer query.
// So here the page's aborts do nothing, and the late answer arrives as such an answer would. The
// test holds both answers, answers the newer first, then the older.
test("a late answer to a replaced query is ignored, even when the abort comes too late", async ({
  page,
}) => {
  await page.addInitScript(() => {
    AbortController.prototype.abort = () => undefined;
  });
  const searches = await holdSearches(page);
  await page.goto("/");

  await field(page).fill("first");
  await field(page).press("Enter");
  const first = await searches.next(1);
  await field(page).fill("second");
  await field(page).press("Enter");
  const second = await searches.next(2);

  await second.answer([{ title: "Found for second" }]);
  await expect(resultTitles(page)).toHaveText(["Found for second"]);
  await expect(status(page)).toHaveText(SEARCH_MESSAGES.one);

  await first.answer([{ title: "Found for first" }, { title: "Also for first" }]);
  // The page has the late answer once the browser has read it. A task queued after that runs
  // after the script's handling of it.
  await (await first.request.response())?.finished();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(resultTitles(page)).toHaveText(["Found for second"]);
  await expect(status(page)).toHaveText(SEARCH_MESSAGES.one);
  await expect(field(page)).toHaveValue("second");
  await expect(searchButton(page)).toBeVisible();
});

test.describe("while a search runs", () => {
  test("the button says Processing… and is never disabled, and the page says it is searching", async ({
    page,
  }) => {
    const searches = await holdSearches(page);
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    const search = await searches.next(1);
    const processing = page.getByRole("button", { name: SEARCH_PROCESSING_LABEL });
    await expect(processing).toBeVisible();
    await expect(processing).toBeEnabled();
    await expect(processing).not.toHaveAttribute("disabled");
    await expect(processing).not.toHaveAttribute("aria-disabled");
    await expect(status(page)).toHaveText(SEARCH_MESSAGES.processing);
    await expect(field(page)).toBeFocused();

    await search.answer(GUIDES);
    await expect(status(page)).toHaveText("2 saved links match your search.");
    await expect(searchButton(page)).toBeVisible();
    await expect(field(page)).toBeFocused();
  });

  // The answer's message replaces the processing message before it is written, so a fast search
  // shows only its count. The clock is paused, so the answer always comes within the delay.
  test("a search that answers within the delay never shows the processing message", async ({
    page,
  }) => {
    await installPausedClock(page);
    await answerSearches(page, () => GUIDES);
    await page.goto("/");
    await page.locator(SEARCH_STATUS).evaluate((region) => {
      const written: string[] = [];
      new MutationObserver(() => written.push(region.textContent ?? "")).observe(region, {
        childList: true,
      });
      Object.assign(window, { written });
    });
    await field(page).fill("testing");
    await field(page).press("Enter");
    await expect(results(page)).toHaveCount(2);
    await page.clock.runFor(500);
    await expect(status(page)).toHaveText("2 saved links match your search.");
    const written = await page.evaluate(() => (window as unknown as { written: string[] }).written);
    expect(written).not.toContain(SEARCH_MESSAGES.processing);
  });

  test("a second press with the same query sends nothing, and the search goes on", async ({
    page,
  }) => {
    const searches = await holdSearches(page);
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    const first = await searches.next(1);
    // Enter in the field, with only the spaces around the query changed, then a click.
    await field(page).fill("  testing ");
    await field(page).press("Enter");
    await page.getByRole("button", { name: SEARCH_PROCESSING_LABEL }).click();
    await expect(status(page)).toHaveText(SEARCH_MESSAGES.processing);
    // The first search was not replaced: its answer is shown.
    await first.answer(GUIDES);
    await expect(results(page)).toHaveCount(2);
    await expect(status(page)).toHaveText("2 saved links match your search.");
    expect(first.aborted()).toBe(false);
    // A changed query is the next search the page sends, so a repeat would have come before it.
    await field(page).fill("changed");
    await field(page).press("Enter");
    expect((await searches.next(2)).query).toBe("changed");
    expect(searches.all).toHaveLength(2);
  });

  test("a changed query aborts the search in flight, and sends the new one", async ({ page }) => {
    const searches = await holdSearches(page);
    await page.goto("/");
    await field(page).fill("first");
    await field(page).press("Enter");
    const first = await searches.next(1);
    await field(page).fill("second");
    await page.getByRole("button", { name: SEARCH_PROCESSING_LABEL }).click();
    const second = await searches.next(2);
    expect(second.query).toBe("second");
    await expect.poll(() => first.aborted()).toBe(true);
    // The new search runs, and its answer is the one shown.
    await expect(page.getByRole("button", { name: SEARCH_PROCESSING_LABEL })).toBeVisible();
    await second.answer([{ title: "Found for second" }]);
    await expect(resultTitles(page)).toHaveText(["Found for second"]);
    await expect(searchButton(page)).toBeVisible();
  });

  test("an empty query stops the search in flight", async ({ page }) => {
    const searches = await holdSearches(page);
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    const search = await searches.next(1);
    await field(page).fill("   ");
    await field(page).press("Enter");
    await expect.poll(() => search.aborted()).toBe(true);
    await expect(searchButton(page)).toBeVisible();
    await expect(status(page)).toHaveText(SEARCH_MESSAGES.empty);
  });

  // Playwright's clock runs in real time once installed, and the test moves it on past the limit.
  test("a search that takes 30 s gives up, says so, and the form is ready to try again", async ({
    page,
  }) => {
    await page.clock.install();
    const searches = await holdSearches(page);
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    const search = await searches.next(1);
    await page.clock.fastForward(29_000);
    await expect(status(page)).toHaveText(SEARCH_MESSAGES.processing);
    expect(search.aborted()).toBe(false);
    await page.clock.fastForward(1_200);
    await expectFailure(page, SEARCH_MESSAGES.timeout);
    await expect.poll(() => search.aborted()).toBe(true);
    await expect(searchButton(page)).toBeVisible();
    await expect(field(page)).toBeFocused();
    await field(page).press("Enter");
    expect((await searches.next(2)).query).toBe("testing");
  });

  // The page's back-forward cache can restore it as it was left, still searching. Playwright's
  // Chromium does not show whether it used the cache, so the event the browser fires for a
  // restored page is dispatched here, as in address-form.e2e.ts.
  test("a page restored from the back-forward cache while searching is ready, and says nothing", async ({
    page,
  }) => {
    const searches = await holdSearches(page);
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    const search = await searches.next(1);
    await expect(status(page)).toHaveText(SEARCH_MESSAGES.processing);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await expect(searchButton(page)).toBeVisible();
    await expect(status(page)).toBeEmpty();
    await expect.poll(() => search.aborted()).toBe(true);
  });

  // A count still waiting to be written when the page was left belongs to that moment, so a
  // restore drops it, with no search running. The clock is paused, so the count is still waiting
  // when the event is dispatched.
  test("a page restored from the back-forward cache drops a message still waiting to be written", async ({
    page,
  }) => {
    await installPausedClock(page);
    await answerSearches(page, () => GUIDES);
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    await expect(results(page)).toHaveCount(2);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await page.clock.runFor(500);
    await expect(status(page)).toBeEmpty();
    await expect(results(page)).toHaveCount(2);
  });
});

// Some of the collection could not be searched (the `partial` outcome, #212), so the results
// are those of the links that were.
test.describe("an incomplete search", () => {
  test("shows its results, and says how many with the notice that there may be more", async ({
    page,
  }) => {
    await answerSearches(page, () => ({ results: GUIDES, outcome: "partial" }));
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    await expect(status(page)).toHaveText(
      `2 saved links match your search. ${SEARCH_MESSAGES.incomplete}`,
    );
    await expect(results(page)).toHaveCount(2);
    await expect(status(page).locator(".alert")).toHaveCount(0);
    await expect(field(page)).toBeFocused();
  });

  // A link that was not searched may match, so the page doesn't say that nothing matches.
  test("that found nothing says so of the links that were searched", async ({ page }) => {
    await answerSearches(page, () => ({ results: [], outcome: "partial" }));
    await page.goto("/");
    await field(page).fill("nothing");
    await field(page).press("Enter");
    await expect(status(page)).toHaveText(
      `${SEARCH_MESSAGES.noneSearched} ${SEARCH_MESSAGES.incomplete}`,
    );
    await expect(page.locator("#search-results")).toBeHidden();
    await expect(status(page)).not.toContainText(SEARCH_MESSAGES.none);
  });
});

// A search whose every chunk failed (the `failed` outcome, #212) is an error status, as are a
// network error and an answer of the wrong shape. Until #214 the real route answers 404, which
// is a failure too.
test.describe("a failed search", () => {
  test("shows the error state in place of the results, not an empty list", async ({ page }) => {
    let fail = false;
    await answerSearches(page, () => (fail ? { status: 503 } : GUIDES));
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    await expect(results(page)).toHaveCount(2);
    fail = true;
    await field(page).press("Enter");
    await expectFailure(page, SEARCH_MESSAGES.failed);
    // The page's one live region holds it, so it is not a second one.
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(field(page)).toBeFocused();
  });

  // Each way a search can fail, and how the test makes it fail. The timeout needs Playwright's
  // clock, which runs in real time once installed, and the test moves it on past the limit.
  const FAILURES: readonly (readonly [
    kind: string,
    message: string,
    fail: (search: HeldSearch, page: Page) => Promise<void>,
  ])[] = [
    ["an error status", SEARCH_MESSAGES.failed, (search) => search.answer({ status: 503 })],
    ["a network error", SEARCH_MESSAGES.network, (search) => search.fail()],
    ["a timeout", SEARCH_MESSAGES.timeout, (_, page) => page.clock.fastForward(30_200)],
  ];

  for (const [kind, message, fail] of FAILURES) {
    test(`after ${kind}, Try again sends the failed query again, back in the field, from the Search button`, async ({
      page,
    }) => {
      if (kind === "a timeout") {
        await page.clock.install();
      }
      const searches = await holdSearches(page);
      await page.goto("/");
      await field(page).fill("testing");
      await field(page).press("Enter");
      await fail(await searches.next(1), page);
      await expectFailure(page, message);
      // A changed query that was not sent goes, because Try again repeats the search that failed.
      await field(page).fill("something else");
      await status(page).getByRole("button", { name: TRY_AGAIN }).focus();
      await page.keyboard.press("Enter");
      const again = await searches.next(2);
      expect(again.query).toBe("testing");
      await expect(field(page)).toHaveValue("testing");
      // Try again goes with the error state, so focus is on Search, where a search is pressed.
      await expect(page.getByRole("button", { name: SEARCH_PROCESSING_LABEL })).toBeFocused();
      await expect(status(page).getByRole("button")).toHaveCount(0);
      if (kind === "a timeout") {
        // The search sent again has a time limit of its own, which starts with it.
        await page.clock.fastForward(29_000);
        await expect(status(page)).toHaveText(SEARCH_MESSAGES.processing);
        expect(again.aborted()).toBe(false);
      }
      await again.answer(GUIDES);
      await expect(results(page)).toHaveCount(2);
      await expect(searchButton(page)).toBeFocused();
    });
  }

  test("by a network error says so", async ({ page }) => {
    await page.route("**/api/search", (route) => route.abort("failed"));
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    await expectFailure(page, SEARCH_MESSAGES.network);
  });

  // Typing goes on in the field while the search runs, and the failure doesn't interrupt it.
  test("doesn't take focus from a person typing in the field", async ({ page }) => {
    const searches = await holdSearches(page);
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    const search = await searches.next(1);
    await page.keyboard.type(" more");
    await search.answer({ status: 503 });
    await expectFailure(page, SEARCH_MESSAGES.failed);
    await page.keyboard.type(" words");
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue("testing more words");
  });

  // The page checks the answer's shape by hand, as the schema does, and the stub's answers
  // always pass the schema, so these answers are written by hand. A result's ID goes into
  // element IDs, which an aria-labelledby list refers to (#208), and its saved time is formatted
  // as a date, which a time outside a Date's range can't be.
  const result = {
    id: "b-1",
    title: "A guide",
    description: null,
    url: "https://example.com/",
    createdAt: SAVED_AT,
  };
  for (const [kind, body] of [
    [
      "with a result ID that holds whitespace",
      { runId: "r-1", outcome: "ok", results: [{ ...result, id: "a b" }] },
    ],
    ["without an outcome", { runId: "r-1", results: [result] }],
    ["with the failed outcome", { runId: "r-1", outcome: "failed", results: [] }],
    [
      "with a result without its saved time",
      { runId: "r-1", outcome: "ok", results: [{ ...result, createdAt: undefined }] },
    ],
    [
      "with a saved time past the latest Date",
      { runId: "r-1", outcome: "ok", results: [{ ...result, createdAt: 8.64e15 + 1 }] },
    ],
  ] as const) {
    test(`by an answer ${kind} says so`, async ({ page }) => {
      await page.route("**/api/search", (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(body) }),
      );
      await page.goto("/");
      await field(page).fill("guide");
      await field(page).press("Enter");
      await expectFailure(page, SEARCH_MESSAGES.failed);
      await expect(results(page)).toHaveCount(0);
    });
  }
});

// No stub: these reach the Worker's own route.
test.describe("against the Worker's own /api/search", () => {
  test("a search gets the 404 of a route that doesn't exist yet, as a failure", async ({
    page,
  }) => {
    await page.goto("/");
    await field(page).fill("testing");
    await field(page).press("Enter");
    await expectFailure(page, SEARCH_MESSAGES.failed);
  });

  // The Worker answers a script's request without a session with 401, and the page says the
  // person is signed out, with a link that signs in and comes back here. Trying again would be
  // signed out again, so there is no Try again.
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
    await expect(status(page).getByRole("button")).toHaveCount(0);
    await expect(searchButton(page)).toBeVisible();
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
