// Reaches the save pages that report a problem with a link, other than the address form. Since
// #97, GET /save shows the address form for a rejected address, so these pages are reached in
// the two ways that remain (plan, "Save flow").
import { expect, type Page } from "@playwright/test";

/**
 * A hand-built save link whose address passes and whose title is over its cap, which gets the
 * validation page.
 */
export const INVALID_LINK = `/save?${new URLSearchParams({
  url: "https://example.com/invalid-link",
  title: "a".repeat(201),
}).toString()}`;

/**
 * Opens the refusal page, which only POST /save shows now: the save form is opened for a clean
 * address, and its hidden address is changed to one with an access token before it is
 * submitted, as a tampered form would be.
 */
export async function openRefusalPage(page: Page): Promise<void> {
  await page.goto(
    `/save?${new URLSearchParams({ url: "https://example.com/refused" }).toString()}`,
  );
  await page.locator('input[type="hidden"][name="url"]').evaluate((input: HTMLInputElement) => {
    input.value = "https://example.com/?access_token=secret-value";
    input.form?.submit();
  });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link can't be saved");
}
