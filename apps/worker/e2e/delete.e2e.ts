// The plan's Phase 4 acceptance, second half: a bookmark on the list can be deleted from it.
// The dialog that JavaScript adds is tested with the dialog (#43).
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

async function saveThroughForm(page: Page, url: string, title: string): Promise<void> {
  await page.goto(`/save?${new URLSearchParams({ url }).toString()}`);
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved");
}

test("the confirmation page has no axe violations", async ({ page }) => {
  await saveThroughForm(page, "https://example.com/guide", "A guide");
  await page.goto("/");
  await page.getByRole("button", { name: "Delete A guide" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Delete this link?");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("a bookmark can be deleted from the list through the confirmation page", async ({
    page,
    query,
  }) => {
    await saveThroughForm(page, "https://example.com/delete-first", "First guide");
    await saveThroughForm(page, "https://example.com/delete-second", "Second guide");
    await page.goto("/");

    await page.getByRole("button", { name: "Delete First guide" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Delete this link?");
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByRole("status")).toHaveText("Deleted “First guide”.");
    await expect(page.getByRole("button", { name: /^Delete / })).toHaveText(["Delete"]);
    await expect(page.getByRole("button", { name: "Delete Second guide" })).toBeVisible();
    // The Worker's database is shared by the tests in this process, so match these URLs only.
    const rows = await query(
      "SELECT title FROM bookmarks WHERE url IN (?, ?)",
      "https://example.com/delete-first",
      "https://example.com/delete-second",
    );
    expect(rows).toEqual([{ title: "Second guide" }]);
  });

  test("keeping the bookmark goes back to it on the list", async ({ page }) => {
    await saveThroughForm(page, "https://example.com/kept", "Kept guide");
    await page.goto("/");
    await page.getByRole("button", { name: "Delete Kept guide" }).click();
    await page.getByRole("link", { name: "Keep it and go back to your saved links" }).click();
    await expect(page).toHaveURL(/\/#bookmark-/);
    await expect(page.getByRole("button", { name: "Delete Kept guide" })).toBeVisible();
  });
});
