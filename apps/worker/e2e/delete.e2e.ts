// The plan's Phase 4 acceptance, second half: a bookmark on the list can be deleted from it.
// The dialog that JavaScript adds is tested in delete-dialog.e2e.ts.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures.ts";
import { listStatus } from "./list-status.ts";
import { saveThroughForm } from "./save-through-form.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("the confirmation page has no axe violations", async ({ page }) => {
  await saveThroughForm(page, "https://example.com/guide", "A guide");
  await page.goto("/");
  // The dialog script handles the button's submit event; form.submit() skips it, which is
  // what a browser without JavaScript does.
  await page
    .getByRole("button", { name: "Delete A guide" })
    .evaluate((button) => button.closest("form")?.submit());
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Delete this link?");
  // The page can show the heading while its stylesheets are still loading, so without the wait
  // axe could check the unstyled page, in the browser's default colors (#159, #160).
  await page.waitForLoadState("load");
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

    await expect(listStatus(page)).toHaveText("Deleted “First guide”.");
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

  test("keeping the bookmark goes back to it on the list", async ({ page, query }) => {
    await saveThroughForm(page, "https://example.com/kept", "Kept guide");
    const [row] = await query("SELECT id FROM bookmarks WHERE url = ?", "https://example.com/kept");
    await page.goto("/");
    await page.getByRole("button", { name: "Delete Kept guide" }).click();
    await page.getByRole("link", { name: "Keep it and go back to your saved links" }).click();
    expect(new URL(page.url()).hash).toBe(`#bookmark-${String(row?.id)}`);
    await expect(page.getByRole("button", { name: "Delete Kept guide" })).toBeVisible();
  });
});
