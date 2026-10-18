// The "Save a link" address form (#97): the keyboard path from the saved links page and from a
// bare /save to the save form, and the error state when the checks reject an address. axe and
// reflow at 320 px run in design.e2e.ts with the other pages.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

// The header's three stops come first: the wordmark, the navigation and Sign out. The field is
// next, because the page heading on a bare /save is its label, which takes no focus.
async function tabToField(page: Page): Promise<void> {
  for (const control of [
    page.getByRole("link", { name: "Haystack", exact: true }),
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Saved links" }),
    page.getByRole("button", { name: "Sign out" }),
    page.getByLabel("Save a link"),
  ]) {
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
  }
}

async function expectSaveFormFor(page: Page, address: string): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Save a link");
  await expect(page.locator("#save-address")).toHaveText(address);
  await expect(page.getByLabel("Title")).toHaveValue(address);
}

// The page was loaded, not focused by script: nothing has focus, as on the save form after a
// rejected title, so the first Tab goes to the header.
async function expectFocusNotMoved(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
}

test("typing an address on the saved links page and pressing Enter opens the save form", async ({
  page,
}) => {
  await page.goto("/");
  await tabToField(page);
  await page.keyboard.type("https://example.com/typed-on-the-list");
  await page.keyboard.press("Enter");
  await expectSaveFormFor(page, "https://example.com/typed-on-the-list");
  expect(new URL(page.url()).search).toBe(
    `?${new URLSearchParams({ url: "https://example.com/typed-on-the-list" }).toString()}`,
  );
});

test("pasting an address on a bare /save and pressing Enter opens the save form", async ({
  page,
}) => {
  await page.goto("/save");
  await tabToField(page);
  // insertText puts the whole text in at once, as pasting does, with no key events.
  await page.keyboard.insertText("https://example.com/pasted");
  await page.keyboard.press("Enter");
  await expectSaveFormFor(page, "https://example.com/pasted");
});

const ADDRESS_RULE =
  "Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long.";
const HINT = "Paste the address of a page. You confirm its title on the next step.";

test("a rejected address shows the error, tied to the field, and keeps the typed value", async ({
  page,
}) => {
  await page.goto("/");
  await tabToField(page);
  // The browser's own checks are off, so a link without https:// reaches the server's.
  await page.keyboard.type("example.com/no-scheme");
  await page.keyboard.press("Enter");

  await expect(page).toHaveTitle("Check the address - Haystack");
  await expect(page.getByRole("alert")).toHaveText(ADDRESS_RULE);
  const field = page.getByLabel("Save a link");
  await expect(field).toHaveValue("example.com/no-scheme");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription(`${ADDRESS_RULE} ${HINT}`);
  await expectFocusNotMoved(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // Correcting the value is enough: the user does not retype it.
  await tabToField(page);
  await page.keyboard.press("Home");
  await page.keyboard.type("https://");
  await page.keyboard.press("Enter");
  await expectSaveFormFor(page, "https://example.com/no-scheme");
});

test("an empty address asks for one", async ({ page }) => {
  await page.goto("/save");
  await tabToField(page);
  await page.keyboard.press("Enter");
  await expect(page).toHaveTitle("Check the address - Haystack");
  await expect(page.getByRole("alert")).toHaveText(
    "Enter the address of a page, starting with https://.",
  );
  await expect(page.getByLabel("Save a link")).toHaveAttribute("aria-invalid", "true");
});

test("a flagged address shows the reason and is not put back in the field", async ({ page }) => {
  await page.goto("/");
  await tabToField(page);
  await page.keyboard.type("https://example.com/cb?access_token=secret-value");
  await page.keyboard.press("Enter");

  await expect(page).toHaveTitle("Check the address - Haystack");
  const reason =
    "This link contains an access token, key, or password, so it could let anyone who has it act as you.";
  await expect(page.getByRole("alert")).toHaveText(reason);
  const field = page.getByLabel("Save a link");
  await expect(field).toHaveValue("");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription(`${reason} ${HINT}`);
  await expectFocusNotMoved(page);
  // The link only remains in the address bar, which the browser put there.
  expect(await page.locator("body").innerHTML()).not.toContain("secret-value");
});
