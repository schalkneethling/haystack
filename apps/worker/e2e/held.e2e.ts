// The review page at /held (#129). Release and Retry are ordinary forms that load the page again,
// with or without JavaScript, and their result is in the page title and the status message, while
// focus is left to the browser. Delete is the delete dialog's with
// JavaScript, which deletes in place, and the confirmation page's without (plan, "Deleting
// bookmarks"). The page's design is tested in design.e2e.ts.
import type { Locator, Page } from "@playwright/test";
import { expect, type HaystackWorker, test } from "./fixtures.ts";
import { listStatus } from "./list-status.ts";
import { saveFailed, saveHeld } from "./review-items.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

function card(page: Page, title: string): Locator {
  return page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });
}

/**
 * Checks that nothing took focus when the page loaded, so the page starts from the top, as the
 * browser leaves it. Only the body has focus, and the result message is not focusable.
 */
async function expectFocusNotMoved(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await expect(listStatus(page).locator("p")).not.toHaveAttribute("tabindex");
}

async function acknowledgedAt(query: HaystackWorker["query"], url: string): Promise<unknown> {
  const [row] = await query(
    "SELECT sensitivity_acknowledged_at AS at FROM bookmarks WHERE url = ?",
    url,
  );
  return row?.at;
}

for (const javaScriptEnabled of [true, false]) {
  test.describe(javaScriptEnabled ? "with JavaScript" : "without JavaScript", () => {
    test.use({ javaScriptEnabled });
    // Each test's addresses are its own in each mode, because the Worker's database is shared.
    const mode = javaScriptEnabled ? "js" : "no-js";

    test("ticking the box and pressing Release releases the link, and focus is left to the browser", async ({
      page,
      run,
      query,
    }) => {
      const url = `https://example.com/release-${mode}`;
      await saveHeld(page, run, url, "Held guide");
      await saveHeld(page, run, `${url}-kept`, "Kept guide");
      await page.goto("/held");

      const held = card(page, "Held guide");
      await held
        .getByRole("checkbox", { name: "This link does not give access to anything private" })
        .check();
      await held.getByRole("button", { name: "Release Held guide" }).click();

      await expect(page).toHaveTitle("Released “Held guide” - Links to review - Haystack");
      await expect(listStatus(page)).toHaveText(
        "Released “Held guide”. Haystack can now describe it.",
      );
      await expectFocusNotMoved(page);
      await expect(held).toHaveCount(0);
      await expect(card(page, "Kept guide")).toBeVisible();
      expect(await acknowledgedAt(query, url)).not.toBeNull();
      expect(await acknowledgedAt(query, `${url}-kept`)).toBeNull();
    });

    test("Release sends nothing until the box is ticked", async ({ page, run, query }) => {
      const url = `https://example.com/release-unticked-${mode}`;
      await saveHeld(page, run, url, "Unticked guide");
      await page.goto("/held");

      const held = card(page, "Unticked guide");
      // A click that sent the form would navigate, and Playwright waits for a navigation that a
      // click starts, so the page would have the result's title by now.
      await held.getByRole("button", { name: "Release Unticked guide" }).click();
      await expect(page).toHaveTitle("Links to review - Haystack");
      await expect(held.locator("input:invalid")).toHaveCount(1);
      await expect(listStatus(page)).toBeEmpty();
      expect(await acknowledgedAt(query, url)).toBeNull();
    });

    test("pressing Retry retries the link, and focus is left to the browser", async ({
      page,
      run,
      query,
    }) => {
      const url = `https://example.com/retry-${mode}`;
      await saveFailed(page, run, url, "Failed guide");
      await saveFailed(page, run, `${url}-kept`, "Kept guide");
      await page.goto("/held");

      const failed = card(page, "Failed guide");
      await expect(failed).toContainText(
        "Last error: Writing its description failed, because the service took too long to answer.",
      );
      await failed.getByRole("button", { name: "Retry Failed guide" }).click();

      await expect(page).toHaveTitle("Retrying “Failed guide” - Links to review - Haystack");
      await expect(listStatus(page)).toHaveText(
        "Retrying “Failed guide”. Haystack will try to describe it again soon.",
      );
      await expectFocusNotMoved(page);
      await expect(failed).toHaveCount(0);
      await expect(card(page, "Kept guide")).toBeVisible();
      const records = await query(
        "SELECT b.url FROM enrichment_failures f JOIN bookmarks b ON b.id = f.bookmark_id WHERE b.url LIKE ?",
        `${url}%`,
      );
      expect(records).toEqual([{ url: `${url}-kept` }]);
    });

    test("the saved links page links to /held only while something waits there", async ({
      page,
      run,
    }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved links");
      await expect(page.getByRole("link", { name: /^Review \d+ links?$/ })).toHaveCount(0);

      await saveHeld(page, run, `https://example.com/link-held-${mode}`, "Held guide");
      await saveFailed(page, run, `https://example.com/link-failed-${mode}`, "Failed guide");
      await page.goto("/");
      await page.getByRole("link", { name: "Review 2 links" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Links to review");
      await expect(card(page, "Held guide")).toBeVisible();
      await expect(card(page, "Failed guide")).toBeVisible();
    });
  });
}

test.describe("with JavaScript, Delete", () => {
  test("deletes in place, sends the form's return page, moves focus to the next card, and announces it", async ({
    page,
    run,
    query,
  }) => {
    const url = "https://example.com/held-dialog";
    await saveHeld(page, run, `${url}-older`, "Older guide");
    await saveHeld(page, run, `${url}-newer`, "Newer guide");
    await page.goto("/held");

    await card(page, "Newer guide").getByRole("button", { name: "Delete Newer guide" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete this link? Newer guide" });
    await expect(dialog).toBeFocused();
    const sent = page.waitForRequest((request) => request.method() === "POST");
    await dialog.getByRole("button", { name: "Delete" }).click();
    expect((await sent).postData()).toBe("confirm=yes&return_to=%2Fheld");

    await expect(dialog).toBeHidden();
    await expect(listStatus(page)).toHaveText("Deleted “Newer guide”.");
    // The cards are newest first, so the next one is the older one.
    await expect(card(page, "Older guide").getByRole("heading", { level: 3 })).toBeFocused();
    await expect(card(page, "Newer guide")).toHaveCount(0);
    // No page load: the page stayed on /held.
    expect(new URL(page.url()).pathname).toBe("/held");
    const rows = await query("SELECT url FROM bookmarks WHERE url LIKE ?", `${url}%`);
    expect(rows).toEqual([{ url: `${url}-older` }]);
  });

  test("removes a section with its last card, then shows the empty state after the last one", async ({
    page,
    run,
  }) => {
    await saveHeld(page, run, "https://example.com/held-last", "Held guide");
    await saveFailed(page, run, "https://example.com/failed-last", "Failed guide");
    await page.goto("/held");
    const pageHeading = page.getByRole("heading", { level: 1, name: "Links to review" });

    await page.getByRole("button", { name: "Delete Held guide" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(pageHeading).toBeFocused();
    await expect(page.getByRole("heading", { name: "Held back" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Not described" })).toBeVisible();
    await expect(page.getByText("Nothing to review.")).toBeHidden();

    await page.getByRole("button", { name: "Delete Failed guide" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(pageHeading).toBeFocused();
    await expect(page.getByRole("heading", { name: "Not described" })).toHaveCount(0);
    await expect(page.getByText("Nothing to review.")).toBeVisible();
    await expect(page.getByRole("list")).toHaveCount(0);
  });
});

test.describe("without JavaScript, Delete", () => {
  test.use({ javaScriptEnabled: false });

  test("asks on the confirmation page, then returns to /held, where focus is left to the browser", async ({
    page,
    run,
    query,
  }) => {
    const url = "https://example.com/held-confirm";
    await saveFailed(page, run, url, "Failed guide");
    await page.goto("/held");

    await page.getByRole("button", { name: "Delete Failed guide" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Delete this link?");
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page).toHaveTitle("Deleted “Failed guide” - Links to review - Haystack");
    await expect(listStatus(page)).toHaveText("Deleted “Failed guide”.");
    await expectFocusNotMoved(page);
    await expect(page.getByText("Nothing to review.")).toBeVisible();
    expect(await query("SELECT id FROM bookmarks WHERE url = ?", url)).toEqual([]);
  });

  test("keeping the link goes back to it on /held", async ({ page, run, query }) => {
    const url = "https://example.com/held-keep";
    await saveHeld(page, run, url, "Kept guide");
    const [row] = await query("SELECT id FROM bookmarks WHERE url = ?", url);
    await page.goto("/held");
    await page.getByRole("button", { name: "Delete Kept guide" }).click();
    await page.getByRole("link", { name: "Keep it and go back to the links to review" }).click();
    expect(new URL(page.url()).pathname).toBe("/held");
    expect(new URL(page.url()).hash).toBe(`#bookmark-${String(row?.id)}`);
    await expect(page.getByRole("button", { name: "Delete Kept guide" })).toBeVisible();
  });
});
