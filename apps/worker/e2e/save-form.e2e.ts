import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures.ts";

const fields = {
  url: "https://example.com/article?utm_source=feed",
  og_title: "An article",
  og_description: "What it is about.",
};

function saveUrl(values: Record<string, string>): string {
  return `/save?${new URLSearchParams(values).toString()}`;
}

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("the save form has no axe violations", async ({ page }) => {
  await page.goto(saveUrl(fields));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Save a link");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test.describe("other /save pages have no axe violations", () => {
  for (const [name, values] of [
    ["the validation page", { url: "javascript:alert(1)" }],
    ["the refusal page", { url: "https://example.com/?access_token=secret" }],
  ] as const) {
    test(name, async ({ page }) => {
      await page.goto(saveUrl(values));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link can't be saved");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });
  }
});

test("the save form can be completed with the keyboard alone", async ({ page }) => {
  await page.goto(saveUrl(fields));
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Title")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Typed title");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Description")).toBeFocused();
  await page.keyboard.press("Tab");
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeFocused();

  const submitted = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/save",
  );
  await page.keyboard.press("Enter");
  expect(new URLSearchParams((await submitted).postData() ?? "").get("confirmed_title")).toBe(
    "Typed title",
  );
});
