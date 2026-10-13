// Saves a page the way a user does: open its /save link, confirm the title, and press Save.
import { expect, type Page } from "@playwright/test";

export async function saveThroughForm(page: Page, url: string, title: string): Promise<void> {
  await page.goto(`/save?${new URLSearchParams({ url }).toString()}`);
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved");
}
