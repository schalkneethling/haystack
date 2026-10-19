// The "Save a link" address form (#97): the keyboard path from the saved links page and from a
// bare /save to the save form, filled in from the page the Worker looks up (#105), the pending
// state while it does, and the error state when the checks reject an address. axe and reflow at
// 320 px run in design.e2e.ts with the other pages.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { PageFixture } from "../test/page-fixture.ts";
import { expect, test } from "./fixtures.ts";
import { PENDING_MESSAGE, stopSubmissions, submissions } from "./stopped-submission.ts";

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
    page.getByRole("textbox", { name: "Save a link" }),
  ]) {
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
  }
}

/** A fixture page with a title and a description, served at `path`. Returns its address. */
function pageAbout(pages: PageFixture, path: string, title: string): string {
  pages.page(
    path,
    `<!doctype html><html lang="en"><head><title>${title} - Example</title>
      <meta property="og:title" content="${title}">
      <meta name="description" content="About ${title}."></head><body></body></html>`,
  );
  return pages.url(path);
}

async function expectSaveFormFor(page: Page, address: string, title: string): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Save a link");
  await expect(page.locator("#save-address")).toHaveText(address);
  await expect(page.getByLabel("Title")).toHaveValue(title);
  await expect(page.getByLabel("Description")).toHaveValue(`About ${title}.`);
}

// The page was loaded, not focused by script: nothing has focus, as on the save form after a
// rejected title, so the first Tab goes to the header.
async function expectFocusNotMoved(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
}

// On the saved links page the form comes before the heading, so it is a named form landmark. On
// its own page the heading is its label, so the form is not named again.
test("the form is a landmark named Save a link on the saved links page only", async ({ page }) => {
  await page.goto("/");
  const form = page.getByRole("form", { name: "Save a link" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Save a link")).toBeVisible();
  await page.goto("/save");
  await expect(page.getByRole("heading", { level: 1, name: "Save a link" })).toBeVisible();
  await expect(page.getByRole("form")).toHaveCount(0);
});

test("typing an address on the saved links page and pressing Enter opens the save form, filled in from the page", async ({
  page,
  pages,
}) => {
  const address = pageAbout(pages, "/typed-on-the-list", "Typed on the list");
  await page.goto("/");
  await tabToField(page);
  await page.keyboard.type(address);
  await page.keyboard.press("Enter");
  await expectSaveFormFor(page, address, "Typed on the list");
  // The lookup redirected to an ordinary save link, which carries what the page said.
  const query = new URL(page.url()).searchParams;
  expect(query.get("url")).toBe(address);
  expect(query.get("og_title")).toBe("Typed on the list");
});

test("pasting an address on a bare /save and pressing Enter opens the save form, filled in from the page", async ({
  page,
  pages,
}) => {
  const address = pageAbout(pages, "/pasted", "Pasted");
  await page.goto("/save");
  await tabToField(page);
  // insertText puts the whole text in at once, as pasting does, with no key events.
  await page.keyboard.insertText(address);
  await page.keyboard.press("Enter");
  await expectSaveFormFor(page, address, "Pasted");
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the form still looks the page up and opens the save form", async ({ page, pages }) => {
    const address = pageAbout(pages, "/no-script", "No script");
    await page.goto("/save");
    await page.getByLabel("Save a link").fill(address);
    await page.getByRole("button", { name: "Continue" }).click();
    await expectSaveFormFor(page, address, "No script");
  });
});

// The pending state, kept on the page by stopping each submission after address-form.js has
// handled it (stopped-submission.ts says how and why).
test.describe("while the page is looked up", () => {
  test.beforeEach(async ({ page }) => {
    await stopSubmissions(page);
  });

  async function expectPending(page: Page): Promise<void> {
    const button = page.getByRole("button", { name: "Looking up…" });
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#save-url-status")).toHaveRole("status");
    await expect(page.locator("#save-url-status")).toHaveText(PENDING_MESSAGE);
  }

  test("Continue says so, the status announces it, and focus stays in the field", async ({
    page,
    pages,
  }) => {
    await page.goto("/");
    await tabToField(page);
    await page.keyboard.type(pages.url("/pending-field"));
    await page.keyboard.press("Enter");

    await expectPending(page);
    await expect(page.getByRole("textbox", { name: "Save a link" })).toBeFocused();
    // A second Enter is refused.
    await page.keyboard.press("Enter");
    expect(await submissions(page)).toEqual(["sent", "refused"]);
  });

  test("Continue keeps focus when it was pressed, and cannot be pressed twice", async ({
    page,
    pages,
  }) => {
    await page.goto("/save");
    await tabToField(page);
    await page.keyboard.type(pages.url("/pending-button"));
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Continue" })).toBeFocused();
    await page.keyboard.press("Enter");

    await expectPending(page);
    const button = page.getByRole("button", { name: "Looking up…" });
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expect(button).toBeFocused();
    expect(await submissions(page)).toEqual(["sent", "refused", "refused"]);
  });

  test("the form is ready again if the request never comes back", async ({ page, pages }) => {
    await page.clock.install();
    await page.goto("/save");
    await page.getByLabel("Save a link").fill(pages.url("/stopped"));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.clock.fastForward(100);
    await expectPending(page);

    // address-form.js waits 15 s, well past the Worker's 3 s limit.
    await page.clock.fastForward(15_000);
    const button = page.getByRole("button", { name: "Continue" });
    await expect(button).toBeFocused();
    await expect(button).not.toHaveAttribute("aria-disabled");
    await expect(page.locator("#save-url-status")).toBeEmpty();
    await button.press("Enter");
    expect(await submissions(page)).toEqual(["sent", "sent"]);
  });

  // A browser can restore the page from its back-forward cache as it was left, still waiting.
  // Playwright's Chromium does not show whether it used the cache, so the event the browser fires
  // for a restored page is dispatched here.
  test("the form is ready again when the page is restored from the back-forward cache", async ({
    page,
    pages,
  }) => {
    await page.goto("/save");
    await page.getByLabel("Save a link").fill(pages.url("/restored"));
    await page.getByRole("button", { name: "Continue" }).click();
    await expectPending(page);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    const button = page.getByRole("button", { name: "Continue" });
    await expect(button).not.toHaveAttribute("aria-disabled");
    await expect(page.locator("#save-url-status")).toBeEmpty();
  });
});

test("going back to the form after the save form opened finds it ready", async ({
  page,
  pages,
}) => {
  const address = pageAbout(pages, "/back", "Back again");
  await page.goto("/save");
  await page.getByLabel("Save a link").fill(address);
  await page.getByRole("button", { name: "Continue" }).click();
  await expectSaveFormFor(page, address, "Back again");
  await page.goBack();
  const button = page.getByRole("button", { name: "Continue" });
  await expect(button).toBeVisible();
  await expect(button).not.toHaveAttribute("aria-disabled");
  await expect(page.locator("#save-url-status")).toBeEmpty();
});

const ADDRESS_RULE =
  "Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long.";
const HINT = "Paste the address of a page. You confirm its title on the next step.";

test("a rejected address shows the error, tied to the field, and keeps the typed value", async ({
  page,
  pages,
}) => {
  const address = pageAbout(pages, "/no-scheme", "No scheme");
  const withoutScheme = address.replace("https://", "");
  await page.goto("/");
  await tabToField(page);
  // The browser's own checks are off, so a link without https:// reaches the server's.
  await page.keyboard.type(withoutScheme);
  await page.keyboard.press("Enter");

  await expect(page).toHaveTitle("Check the address - Haystack");
  await expect(page.getByRole("alert")).toHaveText(ADDRESS_RULE);
  const field = page.getByRole("textbox", { name: "Save a link" });
  await expect(field).toHaveValue(withoutScheme);
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription(`${ADDRESS_RULE} ${HINT}`);
  await expectFocusNotMoved(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // A rejected address is never looked up.
  expect(pages.requests.filter((request) => request.path === "/no-scheme")).toHaveLength(0);

  // Correcting the value is enough: the user does not retype it.
  await tabToField(page);
  await page.keyboard.press("Home");
  await page.keyboard.type("https://");
  await page.keyboard.press("Enter");
  await expectSaveFormFor(page, address, "No scheme");
});

test("an empty address asks for one", async ({ page }) => {
  await page.goto("/save");
  await tabToField(page);
  await page.keyboard.press("Enter");
  await expect(page).toHaveTitle("Check the address - Haystack");
  await expect(page.getByRole("alert")).toHaveText(
    "Enter the address of a page, starting with https://.",
  );
  await expect(page.getByRole("textbox", { name: "Save a link" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("a flagged address shows the reason and is not put back in the field", async ({
  page,
  pages,
}) => {
  await page.goto("/");
  await tabToField(page);
  await page.keyboard.type(pages.url("/cb?access_token=secret-value"));
  await page.keyboard.press("Enter");

  await expect(page).toHaveTitle("Check the address - Haystack");
  const reason =
    "This link contains an access token, key, or password, so it could let anyone who has it act as you.";
  await expect(page.getByRole("alert")).toHaveText(reason);
  const field = page.getByRole("textbox", { name: "Save a link" });
  await expect(field).toHaveValue("");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription(`${reason} ${HINT}`);
  await expectFocusNotMoved(page);
  // The link was posted, so it is not in the address bar either, and it was never looked up.
  expect(await page.locator("body").innerHTML()).not.toContain("secret-value");
  expect(page.url()).not.toContain("secret-value");
  expect(pages.requests.filter((request) => request.path.startsWith("/cb"))).toHaveLength(0);
});
