// The live region where the result of an action on a bookmark is shown: a deletion on the saved
// links page, and a release, a retry or a deletion on /held, which gives it the same ID. The
// address form above the saved links has a status region of its own (#105), so that page has
// two.
import type { Locator, Page } from "@playwright/test";

export function listStatus(page: Page): Locator {
  return page.getByRole("status").and(page.locator("#list-status"));
}
