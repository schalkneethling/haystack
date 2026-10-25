import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures.ts";
import { INVALID_LINK, openRefusalPage } from "./rejected-save-pages.ts";

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

test("the form after a rejected title has no axe violations", async ({ page }) => {
  await page.goto(saveUrl(fields));
  // Only spaces pass the browser's `required` check and fail on the server, after trimming.
  await page.getByLabel("Title").fill("   ");
  await page.getByRole("button", { name: "Save" }).click();
  // Both the form and the page after it have the heading "Save a link", so wait for the title.
  await expect(page).toHaveTitle("Check the form - Haystack");
  await expect(page.getByRole("alert")).toHaveText("Enter a title of up to 200 characters.");
  // The page can show the title and the alert while its stylesheets are still loading, so
  // without the wait axe could check the unstyled page, in the browser's default colors
  // (#159, #160).
  await page.waitForLoadState("load");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

// A rejected address gets the address form (#97), which address-form.e2e.ts scans. These pages
// are reached the ways that remain.
test.describe("other /save pages have no axe violations", () => {
  test("the validation page", async ({ page }) => {
    await page.goto(INVALID_LINK);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link can't be saved");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test("the refusal page", async ({ page }) => {
    await openRefusalPage(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

test("the save form can be completed with the keyboard alone", async ({ page }) => {
  await page.goto(saveUrl(fields));
  // The header's three stops come first: the wordmark, the navigation and Sign out.
  for (const control of [
    page.getByRole("link", { name: "Haystack", exact: true }),
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Saved links" }),
    page.getByRole("button", { name: "Sign out" }),
    page.getByLabel("Title"),
  ]) {
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
  }
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
