import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures.ts";

const fields = {
  url: "https://example.com/article?utm_source=feed",
  og_title: "An article",
  og_description: "What it is about.",
};

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("the save form has no axe violations", async ({ page }) => {
  await page.goto(`/save?${new URLSearchParams(fields).toString()}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Save a link");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("the save form can be completed with the keyboard alone", async ({ page }) => {
  await page.goto(`/save?${new URLSearchParams(fields).toString()}`);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Title")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Description")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Save" })).toBeFocused();
});
