// The message bar (design review): each page's messages in one region right after its heading,
// which message-bar.js makes stick to the top of the viewport, scrolls into view when a message
// arrives, and closes. The bar's design in both color schemes and at 320 px is checked with the
// pages' states in design.e2e.ts.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { answerSearches, SEARCH_MESSAGES, SEARCH_STATUS, TRY_AGAIN } from "./search-answers.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

function bar(page: Page): Locator {
  return page.locator("#messages");
}

function close(page: Page): Locator {
  return page.getByRole("button", { name: "Close messages" });
}

function searchField(page: Page): Locator {
  return page.getByRole("searchbox", { name: "Search your saved links" });
}

async function search(page: Page, query: string): Promise<void> {
  await searchField(page).fill(query);
  await searchField(page).press("Enter");
}

const NOTICE = "Do not save links that contain access tokens";

// Every page with a message has one bar, a direct child of <main>, right after the heading.
for (const [name, path] of [
  ["the search page", "/"],
  ["the saved links page", "/saved-links"],
  ["the address form's page", "/save"],
  ["the save form", "/save?url=https%3A%2F%2Fexample.com%2Fbar&title=A+page"],
  ["the review page", "/held"],
] as const) {
  test(`${name} has one message bar, right after its heading`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator("#messages")).toHaveCount(1);
    await expect(page.locator("main > h1 + #messages.message-bar")).toHaveCount(1);
  });
}

test("the bar sticks to the top of the viewport and spans it once the page is scrolled", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await answerSearches(page, () =>
    Array.from({ length: 12 }, (_, index) => ({ title: `Result ${index}` })),
  );
  await page.goto("/");
  await search(page, "many");
  await expect(page.locator("#search-results > li")).toHaveCount(12);
  await page.mouse.wheel(0, 2000);
  await expect.poll(async () => (await bar(page).boundingBox())?.y).toBeCloseTo(0, 0);
  const box = await bar(page).boundingBox();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box?.x).toBeCloseTo(0, 0);
  expect(box?.width).toBeCloseTo(width, 0);
  await expect(bar(page)).toContainText("12 saved links match your search.");
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  // Only the script can close the bar, so without it the bar stays in the page's flow, where it
  // can't cover the page at high zoom.
  test("the messages show in the page's flow, with nothing to close", async ({ page }) => {
    await page.goto("/saved-links");
    await expect(bar(page)).toContainText(NOTICE);
    await expect(bar(page)).toHaveCSS("position", "static");
    await expect(close(page)).toHaveCount(0);
  });
});

test.describe("Close", () => {
  test("hides the messages and moves focus to the page's heading", async ({ page }) => {
    await page.goto("/saved-links");
    await expect(close(page)).toBeVisible();
    await close(page).click();
    await expect(page.locator("#sensitive-notice")).toBeHidden();
    await expect(close(page)).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Saved links" })).toBeFocused();
    // Nothing is left to draw, so the bar takes no space.
    const box = await bar(page).boundingBox();
    expect(box?.height ?? 0).toBe(0);
  });

  // The status region is emptied, never hidden, so a screen reader announces the next message in
  // it, and the bar comes back with that message. The notice, which hasn't changed, stays closed.
  test("leaves the live region shown, and a new message shows the bar again", async ({ page }) => {
    await answerSearches(page, () => [{ title: "A guide" }]);
    await page.goto("/");
    await search(page, "first");
    await expect(page.locator(SEARCH_STATUS)).toHaveText(SEARCH_MESSAGES.one);
    await close(page).click();
    await expect(page.locator(SEARCH_STATUS)).toBeEmpty();
    await expect(page.locator(SEARCH_STATUS)).not.toHaveAttribute("hidden");
    await search(page, "second");
    await expect(page.locator(SEARCH_STATUS)).toHaveText(SEARCH_MESSAGES.one);
    await expect(close(page)).toBeVisible();
    await expect(page.locator("#sensitive-notice")).toBeHidden();
  });

  // On the search page the bar is before the form, so after a failure, Shift+Tab from the field
  // reaches Close, then Try again, in the bar's order.
  test("comes after a message's own controls in the Tab order", async ({ page }) => {
    await answerSearches(page, () => ({ status: 503 }));
    await page.goto("/");
    await search(page, "failing");
    const tryAgain = page.getByRole("button", { name: TRY_AGAIN });
    await expect(tryAgain).toBeVisible();
    await expect(searchField(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(tryAgain).toBeFocused();
  });
});

// Try again takes the error's theme (design review): the danger style, not the primary straw.
test("Try again in a failed search has the danger style", async ({ page }) => {
  await answerSearches(page, () => ({ status: 503 }));
  await page.goto("/");
  await search(page, "failing");
  await expect(page.getByRole("button", { name: TRY_AGAIN })).toHaveClass(/\bbutton-danger\b/);
});

// The bar is scrolled into view when a message arrives, which matters most at high zoom. The call
// is recorded rather than measured, because the scroll it makes depends on where the bar already
// is, and a stuck bar is already in view.
for (const [preference, behavior] of [
  ["no-preference", "smooth"],
  ["reduce", "instant"],
] as const) {
  test(`a new message scrolls the bar into view, ${behavior === "smooth" ? "smoothly" : "at once when reduced motion is preferred"}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: preference });
    await page.addInitScript(() => {
      const calls: unknown[] = [];
      Reflect.set(window, "scrollCalls", calls);
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
        if (this.id === "messages") {
          calls.push(options);
        }
        original.call(this, options as ScrollIntoViewOptions);
      };
    });
    await answerSearches(page, () => [{ title: "A guide" }]);
    await page.goto("/");
    await search(page, "scrolling");
    await expect(page.locator(SEARCH_STATUS)).toHaveText(SEARCH_MESSAGES.one);
    const calls = await page.evaluate(() => Reflect.get(window, "scrollCalls") as unknown[]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)).toEqual({ block: "nearest", behavior });
  });
}

// A control that Shift+Tab moves to above the viewport is scrolled into view below the stuck bar,
// never under it (WCAG 2.4.11), because the bar's height is the root's scroll padding.
test("Shift+Tab never leaves a focused control under the bar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  await answerSearches(page, () =>
    Array.from({ length: 12 }, (_, index) => ({ title: `Result ${index}` })),
  );
  await page.goto("/");
  await search(page, "many");
  await expect(page.locator("#search-results > li")).toHaveCount(12);
  // To the last result's Delete button, past the bottom of the viewport.
  await page.getByRole("button", { name: "Delete Result 11" }).focus();
  for (let step = 0; step < 10; step += 1) {
    await page.keyboard.press("Shift+Tab");
    const barBottom = await bar(page).evaluate((element) => element.getBoundingClientRect().bottom);
    const focusedTop = await page.evaluate(
      () => document.activeElement?.getBoundingClientRect().top ?? 0,
    );
    expect(focusedTop).toBeGreaterThanOrEqual(barBottom - 1);
  }
});
