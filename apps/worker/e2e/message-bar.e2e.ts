// The message bar (design review): each page's messages in one region right after its heading,
// which message-bar.js makes stick to the top of the viewport, scrolls into view when a message
// arrives, and closes. The bar's design in both color schemes and at 320 px is checked with the
// pages' states in design.e2e.ts.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { holdLookups } from "./held-lookups.ts";
import { saveFailed } from "./review-items.ts";
import { saveThroughForm } from "./save-through-form.ts";
import {
  answerSearches,
  saveResults,
  SEARCH_MESSAGES,
  SEARCH_STATUS,
  TRY_AGAIN,
} from "./search-answers.ts";

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

// A viewport the bar sticks in. With a search's message and the notice, the bar is about 200 px
// tall, a third of a 600 px viewport, so a third of 800 px leaves room for the fonts to draw a
// little taller on another system. The tests that need a stuck bar check that it is.
const STUCK_VIEWPORT = { width: 1280, height: 800 };

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
  await page.setViewportSize(STUCK_VIEWPORT);
  await answerSearches(page, () =>
    Array.from({ length: 12 }, (_, index) => ({ title: `Result ${index}` })),
  );
  await page.goto("/");
  await search(page, "many");
  await expect(page.locator("#search-results > li")).toHaveCount(12);
  await expect(bar(page)).toHaveAttribute("data-stuck");
  // The bar's box is as wide as the content, and its fill and borders are drawn out to the
  // viewport's edges (site.css says how), so what is checked is the pixels drawn at both edges.
  const [width, surface, border] = await bar(page).evaluate((element) => [
    document.documentElement.clientWidth,
    getComputedStyle(element).backgroundColor,
    getComputedStyle(element).borderTopColor,
  ]);
  const edges = async (): Promise<string[]> => {
    const box = await bar(page).boundingBox();
    if (box === null) {
      throw new Error("The bar is not drawn");
    }
    const top = Math.round(box.y);
    const middle = Math.round(box.y + box.height / 2);
    return pixels(page, [0, top], [width - 1, top], [0, middle], [width - 1, middle]);
  };
  // The top border is checked before the page scrolls, because a scroll by the wheel can stop
  // between pixels, and the 1 px border of the bar stuck at the top is then not drawn on a whole
  // row.
  expect(await edges()).toEqual([border, border, surface, surface]);
  await page.mouse.wheel(0, 2000);
  await expect.poll(async () => (await bar(page).boundingBox())?.y).toBeCloseTo(0, 0);
  expect((await edges()).slice(2)).toEqual([surface, surface]);
  await expect(bar(page)).toContainText("12 saved links match your search.");
});

// The colors drawn at points in the viewport, as `rgb(r, g, b)`. The screenshot is decoded in the
// page, from a blob, which the page's Content Security Policy doesn't limit as it does images.
async function pixels(page: Page, ...points: [number, number][]): Promise<string[]> {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ({ png, points }) => {
      const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const context = new OffscreenCanvas(image.width, image.height).getContext("2d");
      if (context === null) {
        throw new Error("No 2D canvas");
      }
      context.drawImage(image, 0, 0);
      return points.map(([x, y]) => {
        const [red, green, blue] = context.getImageData(x, y, 1, 1).data;
        return `rgb(${red}, ${green}, ${blue})`;
      });
    },
    { png, points },
  );
}

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

// The bar is scrolled into view when a message arrives and it isn't in view, which matters most at
// high zoom. In a 320 by 256 viewport, a 1280 by 1024 window at 400%, the bar is too tall to
// stick, and focusing the field scrolls it out of view. The call is recorded rather than
// measured, because a smooth scroll takes a moment to end.
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
      const original: unknown = Reflect.get(Element.prototype, "scrollIntoView");
      Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
        if (this.id === "messages") {
          calls.push(options);
        }
        Reflect.apply(original as Element["scrollIntoView"], this, [options]);
      };
    });
    await page.setViewportSize({ width: 320, height: 256 });
    await answerSearches(page, () => [{ title: "A guide" }]);
    await page.goto("/");
    await expect(bar(page)).not.toHaveAttribute("data-stuck");
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
  await page.setViewportSize(STUCK_VIEWPORT);
  await answerSearches(page, () =>
    Array.from({ length: 12 }, (_, index) => ({ title: `Result ${index}` })),
  );
  await page.goto("/");
  await search(page, "many");
  await expect(page.locator("#search-results > li")).toHaveCount(12);
  await expect(bar(page)).toHaveAttribute("data-stuck");
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

// At 400% zoom (a 320 by 256 viewport), the bar with only the notice is taller than the viewport.
// Stuck, it would hide whatever Tab moved to, so it stays in the page's flow, and the scroll
// padding is 0 (WCAG 2.4.11).
test("a bar too tall for the viewport doesn't stick, and Shift+Tab never lands under it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 256 });
  await answerSearches(page, () =>
    Array.from({ length: 8 }, (_, index) => ({ title: `Result ${index}` })),
  );
  await page.goto("/");
  await search(page, "many");
  await expect(page.locator("#search-results > li")).toHaveCount(8);
  await expect(bar(page)).not.toHaveAttribute("data-stuck");
  await expect(bar(page)).toHaveCSS("position", "static");
  await page.getByRole("button", { name: "Delete Result 7" }).focus();
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("Shift+Tab");
    const visible = await page.evaluate(() => {
      const box = document.activeElement?.getBoundingClientRect();
      const bar = document.getElementById("messages")?.getBoundingClientRect();
      return (
        box !== undefined && bar !== undefined && (box.top >= bar.bottom || box.bottom <= bar.top)
      );
    });
    expect(visible).toBe(true);
  }
  // The window grows, and the bar fits a third of it again, so it sticks.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(bar(page)).toHaveAttribute("data-stuck");
});

// A stuck bar is already in view, so a new message doesn't scroll the page. The scroll padding
// would otherwise count the stuck bar as out of view, and move the page up by its height.
test("a message that arrives while the bar is stuck doesn't move the page", async ({ page }) => {
  await page.setViewportSize(STUCK_VIEWPORT);
  await answerSearches(page, () =>
    Array.from({ length: 30 }, (_, index) => ({ title: `Result ${index}` })),
  );
  await page.goto("/");
  await search(page, "first");
  await expect(page.locator("#search-results > li")).toHaveCount(30);
  await expect(bar(page)).toHaveAttribute("data-stuck");
  await page.evaluate(() => window.scrollTo(0, 600));
  // The browser may move the scroll position to keep the content still while the bar grows above
  // it, so what is checked is where a card on screen is drawn.
  const card = page.locator("#search-results > li").nth(12);
  const before = (await card.boundingBox())?.y;
  // Written by script, as a delete does, so that focus and the field stay where they are.
  await page.locator(SEARCH_STATUS).evaluate((status) => {
    const message = document.createElement("p");
    message.textContent = "A new message.";
    status.replaceChildren(message);
  });
  await page.waitForTimeout(400);
  await expect(bar(page)).toHaveAttribute("data-stuck");
  expect((await card.boundingBox())?.y).toBeCloseTo(before ?? 0, 0);
});

// Close moves focus to the heading without scrolling to it, so a person who closed the bar while
// reading further down stays where they were.
test("Close doesn't scroll the page back to the top", async ({ page }) => {
  await page.setViewportSize(STUCK_VIEWPORT);
  await answerSearches(page, () =>
    Array.from({ length: 30 }, (_, index) => ({ title: `Result ${index}` })),
  );
  await page.goto("/");
  await search(page, "many");
  await expect(page.locator("#search-results > li")).toHaveCount(30);
  await expect(bar(page)).toHaveAttribute("data-stuck");
  await page.evaluate(() => window.scrollTo(0, 1200));
  // A card on screen stays where it is drawn.
  const card = page.locator("#search-results > li").nth(18);
  const before = (await card.boundingBox())?.y ?? 0;
  // A click where the button is drawn, as a person makes it. Playwright's own click first scrolls
  // the button into view, and the scroll padding, which the stuck bar sits in, makes it scroll.
  const button = await close(page).boundingBox();
  if (button === null) {
    throw new Error("Close is not drawn");
  }
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await page.waitForTimeout(300);
  expect(Math.abs(((await card.boundingBox())?.y ?? 0) - before)).toBeLessThanOrEqual(1);
  await expect(page.getByRole("heading", { level: 1 })).not.toBeInViewport();
});

// The delete dialog focuses the next card's heading, then writes its message 500 ms later. A bar
// that grows with the message, here from closed, must not cover that heading.
test("a message that grows the bar doesn't cover the element that has focus", async ({
  page,
  query,
}) => {
  await page.setViewportSize(STUCK_VIEWPORT);
  const saved = await saveResults(
    page,
    query,
    "message-bar-cover",
    Array.from({ length: 9 }, (_, index) => `Covered guide ${index}`),
  );
  await answerSearches(page, () => saved);
  await page.goto("/");
  await search(page, "covered");
  await expect(page.locator("#search-results > li")).toHaveCount(9);
  await close(page).click();
  await expect(close(page)).toBeHidden();
  const button = page.getByRole("button", { name: "Delete Covered guide 6" });
  await button.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 300));
  await button.click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(SEARCH_STATUS)).toContainText("Deleted");
  await expect(bar(page)).toHaveAttribute("data-stuck");
  await page.waitForTimeout(400);
  const covered = await page.evaluate(() => {
    const box = document.activeElement?.getBoundingClientRect();
    const bar = document.getElementById("messages")?.getBoundingClientRect();
    return box === undefined || bar === undefined || box.top < bar.bottom - 1;
  });
  expect(covered).toBe(false);
});

// The address form's failure may take focus from the page's heading, where Close leaves focus,
// because Close emptied the processing message that would otherwise have given it focus.
test("a lookup that fails after Close still takes focus with its message", async ({
  page,
  pages,
}) => {
  const lookups = await holdLookups(page);
  await page.goto("/save");
  await page.getByRole("textbox", { name: "Save a link" }).fill(pages.url("/closed-then-failed"));
  await page.getByRole("textbox", { name: "Save a link" }).press("Enter");
  const lookup = await lookups.next(1);
  await expect(page.locator("#save-url-status > p")).toBeFocused();
  await close(page).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await lookup.fail();
  await expect(page.locator("#save-url-status > p")).toBeFocused();
});

// The bar comes before the forms and the lists, so its Close is the stop after the header's.
test.describe("Tab order", () => {
  const header = (page: Page) => [
    page.getByRole("link", { name: "Haystack", exact: true }),
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Search" }),
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Saved links" }),
    page.getByRole("button", { name: "Sign out" }),
  ];

  async function expectStops(page: Page, stops: readonly Locator[]): Promise<void> {
    for (const stop of stops) {
      await page.keyboard.press("Tab");
      await expect(stop).toBeFocused();
    }
  }

  test("on the saved links page: the header, Close, the address form, then the cards", async ({
    page,
  }) => {
    await saveThroughForm(page, "https://example.com/tab-order", "Tab order guide");
    await page.goto("/saved-links");
    await expectStops(page, [
      ...header(page),
      close(page),
      page.getByRole("textbox", { name: "Save a link" }),
      page.getByRole("button", { name: "Continue" }),
      page.getByRole("link", { name: "Tab order guide" }),
    ]);
  });

  // /held has no notice, so its bar is empty, and Close only appears with a message.
  test("on /held: the header, then the cards, and Close only once a message arrives", async ({
    page,
    run,
  }) => {
    await saveFailed(page, run, "https://example.com/tab-order-held", "Held tab order");
    await page.goto("/held");
    await expect(close(page)).toBeHidden();
    await expectStops(page, [
      ...header(page),
      page.getByRole("button", { name: "Retry Held tab order" }),
    ]);
    await page.getByRole("button", { name: "Delete Held tab order" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#list-status")).toContainText("Deleted");
    await expect(close(page)).toBeVisible();
    // Deleting the last card moved focus to the heading, which the bar follows.
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close(page)).toBeFocused();
  });
});
