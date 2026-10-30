// Deleting a bookmark from the search results (#208). Each result has the saved links' Delete
// form, and the delete dialog (delete-dialog.e2e.ts) handles it, although the results arrive
// after the page loaded. Without the dialog, the button leads to the confirmation page, which
// returns to the search page. The answers to /api/search are stubbed in the browser
// (search-answers.ts). A test that deletes saves its links first (`saveResults`), so the results
// are real bookmarks, and the delete is the Worker's own. The design's checks are in
// design.e2e.ts, and the Worker's answers in apps/worker/test/search-page.test.ts.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { installPausedClock } from "./held-lookups.ts";
import {
  answerSearches,
  holdSearches,
  SEARCH_MESSAGES,
  SEARCH_STATUS,
  type StubbedAnswer,
  type StubbedResult,
  saveResults,
} from "./search-answers.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

const EMPTY_STATE = "You deleted every link this search found. Search again to find others.";

function field(page: Page) {
  return page.getByRole("searchbox", { name: "Search your saved links" });
}

function status(page: Page) {
  return page.getByRole("status").and(page.locator(SEARCH_STATUS));
}

/** The Search button with its own label, as it is when no search runs. */
function searchButton(page: Page) {
  return page.getByRole("button", { name: "Search", exact: true });
}

function results(page: Page) {
  return page.locator("#search-results > li");
}

function dialog(page: Page) {
  return page.getByRole("dialog", { name: /^Delete this link\?/ });
}

/** The message after `count` results, as the page writes it. */
function countMessage(count: number): string {
  return count === 1
    ? "1 saved link matches your search."
    : `${count} saved links match your search.`;
}

/**
 * Opens the search page, answers every search with `answer`, and searches from the field. Waits
 * for the count when the answer has results.
 */
async function search(page: Page, answer: readonly StubbedResult[]): Promise<void> {
  await answerSearches(page, (): StubbedAnswer => answer);
  await page.goto("/");
  await field(page).fill("guides");
  await field(page).press("Enter");
  await expect(status(page)).toHaveText(countMessage(answer.length));
}

/** Opens the dialog for the result titled `title`, and presses its Delete button. */
async function deleteResult(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: `Delete ${title}` }).click();
  await dialog(page).getByRole("button", { name: "Delete" }).click();
  await expect(dialog(page)).toBeHidden();
}

const STUBBED: readonly StubbedResult[] = [
  { title: "Vitest browser mode guide", description: "Run tests in a real browser." },
  { title: "Playwright locators", description: null },
];

test("each result has a Delete button named by its title, in a form that returns here", async ({
  page,
}) => {
  await search(page, STUBBED);
  for (const [index, { title }] of STUBBED.entries()) {
    const button = results(page)
      .nth(index)
      .getByRole("button", { name: `Delete ${title}` });
    await expect(button).toHaveText("Delete");
    // The saved links' Delete form (bookmark-card.ts), with the search page as the page to
    // return to, so the confirmation page, without the dialog, returns here.
    const form = await button.evaluate((element) => {
      const parent = element.closest("form");
      return {
        method: parent?.getAttribute("method"),
        action: parent?.getAttribute("action"),
        marked: parent?.hasAttribute("data-delete-form"),
        fields: [...new FormData(parent ?? undefined)].map(([name, value]) => [name, value]),
        inCard: parent?.parentElement?.matches("#search-results > li"),
      };
    });
    const id = await results(page).nth(index).getAttribute("id");
    expect(form).toEqual({
      method: "post",
      action: `/bookmarks/${String(id?.replace(/^bookmark-/, ""))}/delete`,
      marked: true,
      fields: [["return_to", "/"]],
      inCard: true,
    });
  }
});

test("the dialog works with the keyboard, with Cancel first, and Escape deletes nothing", async ({
  page,
}) => {
  await search(page, STUBBED);
  // Focus stays in the field after a search. The first result's link and its Delete button come
  // after the Search button.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: STUBBED[0]?.title })).toBeFocused();
  await page.keyboard.press("Tab");
  const button = page.getByRole("button", { name: `Delete ${String(STUBBED[0]?.title)}` });
  await expect(button).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeFocused();
  await expect(dialog(page)).toHaveAccessibleName(`Delete this link? ${String(STUBBED[0]?.title)}`);
  await page.keyboard.press("Tab");
  await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(button).toBeFocused();
  await expect(results(page)).toHaveCount(2);
  await expect(status(page)).toHaveText(countMessage(2));
});

for (const [which, deleted, focused] of [
  ["a middle result", "Middle guide", "Last guide"],
  ["the last result", "Last guide", "Middle guide"],
] as const) {
  test(`deleting ${which} removes it and moves focus to ${focused}'s title`, async ({
    page,
    query,
  }) => {
    const prefix = `search-delete-${deleted.split(" ")[0]?.toLowerCase()}`;
    const saved = await saveResults(page, query, prefix, [
      "First guide",
      "Middle guide",
      "Last guide",
    ]);
    await search(page, saved);
    await deleteResult(page, deleted);

    await expect(results(page)).toHaveCount(2);
    await expect(results(page).getByRole("heading", { name: focused })).toBeFocused();
    await expect(status(page)).toHaveText(`Deleted “${deleted}”.`);
    await expect(page.getByText(EMPTY_STATE)).toBeHidden();
    // No page load: the page is still the one that searched.
    await expect(field(page)).toHaveValue("guides");
    const id = saved.find(({ title }) => title === deleted)?.id;
    expect(await query("SELECT id FROM bookmarks WHERE id = ?", id)).toEqual([]);
  });
}

test("deleting the only result moves focus to the page heading and shows the empty state", async ({
  page,
  query,
}) => {
  const saved = await saveResults(page, query, "search-delete-only", ["Only guide"]);
  await search(page, saved);
  await deleteResult(page, "Only guide");

  await expect(
    page.getByRole("heading", { level: 1, name: "Search your saved links" }),
  ).toBeFocused();
  await expect(page.getByText(EMPTY_STATE)).toBeVisible();
  await expect(page.locator("#search-results")).toBeHidden();
  await expect(status(page)).toHaveText("Deleted “Only guide”.");
});

// The count is not said again after a delete: the region's one message is the deletion's, as on
// the saved links page, and the page's other cards show what is left.
test("the deletion is written once, in place of the count, after focus has moved", async ({
  page,
  query,
}) => {
  const saved = await saveResults(page, query, "search-delete-once", [
    "First guide",
    "Second guide",
  ]);
  await installPausedClock(page);
  await answerSearches(page, () => saved);
  await page.goto("/");
  await field(page).fill("guides");
  await field(page).press("Enter");
  await expect(results(page)).toHaveCount(2);
  await page.clock.runFor(500);
  await expect(status(page)).toHaveText(countMessage(2));

  // Records each message the live region is given, as the scripts write them, with
  // replaceChildren.
  await page.evaluate(() => {
    const region = document.getElementById("list-status");
    if (region === null) {
      throw new Error("The page has no live region");
    }
    const written: string[] = [];
    Object.assign(window, { written });
    const write = region.replaceChildren.bind(region);
    region.replaceChildren = (...nodes) => {
      written.push(
        nodes.map((node) => (typeof node === "string" ? node : node.textContent)).join(""),
      );
      write(...nodes);
    };
  });

  await deleteResult(page, "First guide");
  // Focus has moved, and the message waits for the delay.
  await expect(results(page).getByRole("heading", { name: "Second guide" })).toBeFocused();
  await expect(status(page)).toHaveText(countMessage(2));
  await page.clock.runFor(500);
  await expect(status(page)).toHaveText("Deleted “First guide”.");
  // Well past every timer either script sets, except the search's 30-second limit, which no
  // search is waiting on.
  await page.clock.runFor(5_000);
  expect(await page.evaluate(() => (window as unknown as { written: string[] }).written)).toEqual([
    "Deleted “First guide”.",
  ]);
});

test("the next search hides the empty state again", async ({ page, query }) => {
  const saved = await saveResults(page, query, "search-delete-again", ["Only guide"]);
  const answers: Record<string, readonly StubbedResult[]> = {
    guides: saved,
    others: STUBBED,
    nothing: [],
  };
  await answerSearches(page, (asked) => answers[asked] ?? []);
  await page.goto("/");
  await field(page).fill("guides");
  await field(page).press("Enter");
  await expect(status(page)).toHaveText(countMessage(1));
  await deleteResult(page, "Only guide");
  await expect(page.getByText(EMPTY_STATE)).toBeVisible();

  await field(page).fill("others");
  await field(page).press("Enter");
  await expect(status(page)).toHaveText(countMessage(2));
  await expect(results(page)).toHaveCount(2);
  await expect(page.getByText(EMPTY_STATE)).toBeHidden();

  // A search that finds nothing says so, and the empty state, which is for deleted results,
  // stays hidden.
  await field(page).fill("nothing");
  await field(page).press("Enter");
  await expect(status(page)).toHaveText("No saved links match your search.");
  await expect(page.getByText(EMPTY_STATE)).toBeHidden();
});

// A search can still be running when the dialog opens, because the results of the search before
// stay until it answers. Its results then replace the item that opened the dialog.
test("results that replaced the item while the dialog was open lose the deleted bookmark", async ({
  page,
  query,
}) => {
  const [first, second, third] = await saveResults(page, query, "search-delete-replaced", [
    "First guide",
    "Second guide",
    "Third guide",
  ]);
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("Three results were saved");
  }
  const searches = await holdSearches(page);
  await page.goto("/");
  await field(page).fill("guides");
  await field(page).press("Enter");
  await (await searches.next(1)).answer([first, second]);
  await expect(results(page)).toHaveCount(2);

  await field(page).fill("more guides");
  await field(page).press("Enter");
  const replacing = await searches.next(2);
  await page.getByRole("button", { name: "Delete First guide" }).click();
  await expect(dialog(page)).toBeVisible();
  await replacing.answer([first, third]);
  await expect(results(page).getByRole("heading", { name: "Third guide" })).toHaveCount(1);

  await dialog(page).getByRole("button", { name: "Delete" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).getByRole("heading", { name: "Third guide" })).toBeFocused();
  await expect(status(page)).toHaveText("Deleted “First guide”.");
  expect(await query("SELECT id FROM bookmarks WHERE id = ?", first.id)).toEqual([]);
});

// The answer to a search that was running when the dialog closed replaces the results, with the
// heading the dialog moved focus to. Focus moves to the Search button first, so it never falls to
// the page. The answer was made before the delete, so it can list the deleted bookmark again,
// which is accepted (plan, "Search page").
test("a search answering after a delete moves focus to the Search button, not the page", async ({
  page,
  query,
}) => {
  const saved = await saveResults(page, query, "search-delete-late", [
    "First guide",
    "Second guide",
  ]);
  const searches = await holdSearches(page);
  await page.goto("/");
  await field(page).fill("guides");
  await field(page).press("Enter");
  await (await searches.next(1)).answer(saved);
  await expect(results(page)).toHaveCount(2);

  await field(page).fill("more guides");
  await field(page).press("Enter");
  const late = await searches.next(2);
  await deleteResult(page, "First guide");
  await expect(results(page).getByRole("heading", { name: "Second guide" })).toBeFocused();

  await late.answer(saved);
  await expect(searchButton(page)).toBeFocused();
  await expect(results(page)).toHaveCount(2);
  await expect(status(page)).toHaveText(countMessage(2));
});

// Leaving the page and coming back can restore it from the back-forward cache as it was left. A
// message still waiting to be written belongs to that moment, so a restore drops it. The clock is
// paused, so the message is still waiting when the event is dispatched.
test("a page restored from the back-forward cache drops a deletion message still waiting", async ({
  page,
  query,
}) => {
  const saved = await saveResults(page, query, "search-delete-restored", ["First guide"]);
  await installPausedClock(page);
  await answerSearches(page, () => saved);
  await page.goto("/");
  await field(page).fill("guides");
  await field(page).press("Enter");
  await expect(results(page)).toHaveCount(1);
  await page.clock.runFor(500);
  await expect(status(page)).toHaveText(countMessage(1));

  await deleteResult(page, "First guide");
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
  );
  await page.clock.runFor(1_000);
  await expect(status(page)).toHaveText(countMessage(1));
  await expect(page.getByText(EMPTY_STATE)).toBeVisible();
});

// A browser without the dialog element gets the confirmation page. form.submit() skips the
// dialog script's submit listener, which is what such a browser does, while search.js, which
// builds the results, still runs.
test.describe("without the dialog", () => {
  async function openConfirmation(page: Page, title: string): Promise<void> {
    await page
      .getByRole("button", { name: `Delete ${title}` })
      .evaluate((button) => button.closest("form")?.submit());
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Delete this link?");
  }

  test("the confirmation page deletes and returns to the search page, saying so", async ({
    page,
    query,
  }) => {
    const saved = await saveResults(page, query, "search-delete-page", [
      "First guide",
      "Kept guide",
    ]);
    await search(page, saved);
    await openConfirmation(page, "First guide");
    await expect(page.getByText("Title: First guide")).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page).toHaveTitle("Deleted “First guide” - Search - Haystack");
    expect(new URL(page.url()).pathname).toBe("/bookmarks/" + String(saved[0]?.id) + "/delete");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Search your saved links");
    await expect(status(page)).toHaveText("Deleted “First guide”.");
    // The results exist only in the page that searched, so none are shown.
    await expect(results(page)).toHaveCount(0);
    await expect(page.getByText(EMPTY_STATE)).toBeHidden();
    // Nothing takes focus on a page that loads.
    await expect(page.locator("body")).toBeFocused();
    expect(
      await query("SELECT title FROM bookmarks WHERE id IN (?, ?)", saved[0]?.id, saved[1]?.id),
    ).toEqual([{ title: "Kept guide" }]);
  });

  test("keeping the bookmark goes back to the search page", async ({ page, query }) => {
    const saved = await saveResults(page, query, "search-delete-keep", ["Kept guide"]);
    await search(page, saved);
    await openConfirmation(page, "Kept guide");
    await page.getByRole("link", { name: "Keep it and go back to search" }).click();
    await expect(page).toHaveTitle("Search - Haystack");
    expect(new URL(page.url()).pathname).toBe("/");
    expect(await query("SELECT id FROM bookmarks WHERE id = ?", saved[0]?.id)).toHaveLength(1);
  });

  // The page is shown at the delete's own address after confirming, which sign-in would ask for
  // with GET, and get a 404.
  test("a later search after the session ended offers sign-in back to the search page", async ({
    page,
    query,
  }) => {
    const saved = await saveResults(page, query, "search-delete-sign-in", ["First guide"]);
    await answerSearches(page, (asked): StubbedAnswer =>
      asked === "guides" ? saved : { status: 401 },
    );
    await page.goto("/");
    await field(page).fill("guides");
    await field(page).press("Enter");
    await expect(status(page)).toHaveText(countMessage(1));
    await openConfirmation(page, "First guide");
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page).toHaveTitle("Deleted “First guide” - Search - Haystack");
    // The title matches before the page's module script runs, and Enter before it runs would send
    // the form without it, which only loads the page again. The script hides this message once it
    // runs.
    await expect(page.locator("#search-needs-script")).toBeHidden();

    await field(page).fill("more guides");
    await field(page).press("Enter");
    await expect(status(page)).toHaveText(SEARCH_MESSAGES.signedOut);
    await expect(status(page).getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/auth/sign-in?return_to=%2F",
    );
  });
});
