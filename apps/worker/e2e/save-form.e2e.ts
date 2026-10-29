import AxeBuilder from "@axe-core/playwright";
import type { Route } from "@playwright/test";
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

// The session can end between opening the form and pressing Save (#34). The browser's form
// submission asks for HTML, so the Worker sends it through sign-in and back to the form with what
// the user entered, rather than the 401 that a script's request gets.
test("a save after the session ended comes back to the form with what was entered", async ({
  page,
  baseURL,
  signIn,
  signOut,
  query,
}) => {
  const url = "https://example.com/session-ended";
  await page.goto(saveUrl({ url, og_title: "The page's title" }));
  await page.getByLabel("Title").fill("My own title");
  await page.getByLabel("Description").fill("My notes");
  await signOut();

  // The Worker's answer is read here, without following it, because the redirect after it goes on
  // to Google's sign-in, which a test must not reach. The navigation is answered here instead.
  let submission: { accept: string | null; status: number; location: string | null } | undefined;
  const isSave = (address: URL) => address.pathname === "/save";
  const answerSave = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const response = await route.fetch({ maxRedirects: 0 });
    submission = {
      accept: await route.request().headerValue("accept"),
      status: response.status(),
      location: response.headers()["location"] ?? null,
    };
    await route.fulfill({ contentType: "text/plain", body: "Sent to sign-in" });
  };
  await page.route(isSave, answerSave);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Sent to sign-in")).toBeVisible();
  await page.unroute(isSave, answerSave);

  expect(submission?.accept).toContain("text/html");
  expect(submission?.status).toBe(303);
  const location = new URL(submission?.location ?? "", baseURL);
  expect(location.pathname).toBe("/auth/sign-in");
  const returnTo = location.searchParams.get("return_to") ?? "";

  // Sign-in sends the browser back to the return target, which sign-in.test.ts follows through
  // the callback. Here the browser opens it once it has a session again.
  await signIn();
  await page.goto(returnTo);
  await expect(page).toHaveTitle("Not saved yet - Haystack");
  await expect(page.getByRole("status")).toHaveText(
    "This link is not saved yet. Check the title and description, then press Save.",
  );
  await expect(page.getByLabel("Title")).toHaveValue("My own title");
  await expect(page.getByLabel("Description")).toHaveValue("My notes");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved");
  expect(await query("SELECT title, description FROM bookmarks WHERE url = ?", url)).toEqual([
    { title: "My own title", description: "My notes" },
  ]);
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
  // The header's four stops come first: the wordmark, the navigation's two links and Sign out.
  for (const control of [
    page.getByRole("link", { name: "Haystack", exact: true }),
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Search" }),
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
