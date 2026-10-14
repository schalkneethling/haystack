// The plan's Phase 4 acceptance, first half: a bookmark saved through /save appears at the top
// of the recent saves list. Deletion is covered with the delete tests.
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

// axe runs in the page, so these scans need JavaScript.
test("the empty list has no axe violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("You haven't saved any links yet.")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("the list has no axe violations", async ({ page }) => {
  await saveThroughForm(page, "https://example.com/guide", "A guide");
  await page.goto("/");
  await expect(page.getByRole("listitem")).toHaveCount(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("a bookmark saved through /save appears at the top of the list", async ({ page }) => {
    await saveThroughForm(page, "https://example.com/first", "First guide");
    await saveThroughForm(page, "https://example.com/second", "Second guide");

    await page.getByRole("link", { name: "See it in your saved links" }).click();
    const items = page.getByRole("listitem");
    await expect(items).toHaveCount(2);
    const newest = items.first().getByRole("link", { name: "Second guide" });
    await expect(newest).toHaveAttribute("href", "https://example.com/second");
  });
});
