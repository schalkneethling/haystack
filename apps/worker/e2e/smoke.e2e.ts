// Smoke test: a page the Worker renders loads in a real browser and has no axe violations.
// axe runs every rule, including best practices, on every page (plan, "Testing strategy").
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures.ts";

test("the signed-out page has no axe violations", async ({ page }) => {
  await page.goto("/auth/signed-out");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "You are signed out of Haystack",
  );

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

// The header comes first, and a signed-out page's header has the wordmark only, so the sign-in
// link is the second stop.
test("Tab reaches the wordmark, then the sign-in link, on the signed-out page", async ({
  page,
}) => {
  await page.goto("/auth/signed-out");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Haystack", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Sign in again" })).toBeFocused();
});
