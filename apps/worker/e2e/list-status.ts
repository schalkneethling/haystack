// The saved links list's live region, where a deletion is announced. The address form above the
// list has a status region of its own (#105), so the page has two.
import type { Locator, Page } from "@playwright/test";

export function listStatus(page: Page): Locator {
  return page.getByRole("status").and(page.locator("#list-status"));
}
