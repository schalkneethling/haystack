// Deleting with JavaScript: the Delete button opens a modal dialog instead of the confirmation
// page, and the item is removed in place (plan, "Deleting bookmarks").
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { saveThroughForm } from "./save-through-form.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

async function saveThree(page: Page, prefix: string): Promise<void> {
  for (const name of ["Oldest", "Middle", "Newest"]) {
    await saveThroughForm(page, `https://example.com/${prefix}-${name}`, `${name} ${prefix}`);
  }
  await page.goto("/");
}

test("the dialog confirms, deletes, moves focus to the next item, and announces it", async ({
  page,
  query,
}) => {
  await saveThree(page, "confirm");
  await page.getByRole("button", { name: "Delete Middle confirm" }).click();

  const dialog = page.getByRole("dialog", { name: "Delete this link?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Middle confirm");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status")).toHaveText("Deleted “Middle confirm”.");
  const items = page.getByRole("listitem");
  await expect(items).toHaveCount(2);
  // The next item down the list, which is the older one.
  await expect(items.nth(1)).toBeFocused();
  await expect(items.nth(1)).toContainText("Oldest confirm");
  // No page load: the list stayed on /.
  expect(new URL(page.url()).pathname).toBe("/");
  const rows = await query(
    "SELECT title FROM bookmarks WHERE url LIKE ? ORDER BY title",
    "https://example.com/confirm-%",
  );
  expect(rows).toEqual([{ title: "Newest confirm" }, { title: "Oldest confirm" }]);
});

test("deleting the last item in the list moves focus to the item before it", async ({ page }) => {
  await saveThree(page, "last");
  await page.getByRole("button", { name: "Delete Oldest last" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("listitem").last()).toBeFocused();
  await expect(page.getByRole("listitem").last()).toContainText("Middle last");
});

test("deleting the only item moves focus to the heading and shows the empty state", async ({
  page,
}) => {
  await saveThroughForm(page, "https://example.com/only", "Only guide");
  await page.goto("/");
  await page.getByRole("button", { name: "Delete Only guide" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Saved links" })).toBeFocused();
  await expect(page.getByText("You haven't saved any links yet.")).toBeVisible();
  await expect(page.getByRole("list")).toHaveCount(0);
});

for (const [how, close] of [
  ["Escape", (page: Page) => page.keyboard.press("Escape")],
  [
    "Cancel",
    (page: Page) => page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click(),
  ],
] as const) {
  test(`${how} closes the dialog, deletes nothing, and returns focus to the button`, async ({
    page,
    query,
  }) => {
    await saveThroughForm(page, `https://example.com/kept-${how}`, `Kept ${how}`);
    await page.goto("/");
    const button = page.getByRole("button", { name: `Delete Kept ${how}` });
    await button.click();
    await close(page);
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(button).toBeFocused();
    const rows = await query(
      "SELECT id FROM bookmarks WHERE url = ?",
      `https://example.com/kept-${how}`,
    );
    expect(rows).toHaveLength(1);
  });
}

test("a bookmark already deleted elsewhere is removed and announced", async ({ page, query }) => {
  await saveThroughForm(page, "https://example.com/elsewhere", "Elsewhere guide");
  await page.goto("/");
  await page.getByRole("button", { name: "Delete Elsewhere guide" }).click();
  // Another tab deletes it while the dialog is open.
  const [row] = await query(
    "SELECT id FROM bookmarks WHERE url = ?",
    "https://example.com/elsewhere",
  );
  await page.request.post(`/bookmarks/${String(row?.id)}/delete`, {
    form: { confirm: "yes" },
    headers: { origin: new URL(page.url()).origin },
  });
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("status")).toHaveText("“Elsewhere guide” was already deleted.");
  await expect(page.getByRole("button", { name: "Delete Elsewhere guide" })).toHaveCount(0);
});
