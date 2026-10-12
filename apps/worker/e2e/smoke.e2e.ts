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

test("the first Tab stop on the signed-out page is the sign-in link", async ({ page }) => {
  await page.goto("/auth/signed-out");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Sign in again" })).toBeFocused();
});
