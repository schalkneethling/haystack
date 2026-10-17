import AxeBuilder from "@axe-core/playwright";
import { SENSITIVE_URL_EXPLANATIONS } from "@haystack/schemas";
import { expect, test } from "./fixtures.ts";

const ARTICLE = "https://fixture.test/article";
const SENSITIVE = "https://fixture.test/callback?access_token=fixture-token";

function fixtureDocument(title: string): string {
  return `<!doctype html><html lang="en"><head><title>${title}</title></head><body><p>Fixture</p></body></html>`;
}

test("the toolbar button opens the save form, prefilled with the page's title", async ({
  context,
  fixturePages,
  haystackWorker,
  page,
  signIn,
  toolbar,
}) => {
  await signIn();
  fixturePages.serve(ARTICLE, fixtureDocument("A fixture article"));
  await page.goto(ARTICLE);

  const saveForm = context.waitForEvent("page", {
    predicate: (opened) => opened.url().startsWith(`${haystackWorker.origin}/save?`),
  });
  const popup = await toolbar.click(page);
  const form = await saveForm;

  await expect(form).toHaveURL(
    `${haystackWorker.origin}/save?${new URLSearchParams({ url: ARTICLE, title: "A fixture article" })}`,
  );
  await expect(form.getByRole("heading", { level: 1 })).toHaveText("Save a link");
  await expect(form.getByLabel("Title")).toHaveValue("A fixture article");
  // The popup closes itself once the form is open.
  if (!popup.isClosed()) {
    await popup.waitForEvent("close");
  }
});

test.describe("a sensitive URL", () => {
  test.beforeEach(async ({ fixturePages, page }) => {
    fixturePages.serve(SENSITIVE, fixtureDocument("Signed in"));
    await page.goto(SENSITIVE);
  });

  test("opens no page, and the popup says why", async ({ context, page, toolbar }) => {
    const popup = await toolbar.click(page);

    await expect(popup.getByRole("heading", { level: 1 })).toHaveText("This page can't be saved");
    await expect(popup.getByRole("status")).toHaveText(
      SENSITIVE_URL_EXPLANATIONS["credential-parameter"],
    );
    // A regression that opened the form and still showed the reason would not be caught by
    // listing the pages alone: Playwright might not have attached to the new tab yet. The tab's
    // first request is invisible to Playwright too, so a short wait for a new page is the check.
    const opened = await context.waitForEvent("page", { timeout: 500 }).catch(() => null);
    expect(opened?.url() ?? null).toBeNull();
    expect(context.pages().map((open) => open.url())).toEqual([SENSITIVE, popup.url()]);
  });

  test("the popup's refusal has no axe violations", async ({ page, toolbar }) => {
    const popup = await toolbar.click(page);
    await expect(popup.getByRole("status")).toHaveText(
      SENSITIVE_URL_EXPLANATIONS["credential-parameter"],
    );

    // By default axe gathers its results in a new page, and Chromium closes a popup as soon as
    // another page takes focus. Legacy mode runs axe in the page alone, and only skips
    // cross-origin frames, which the popup doesn't have.
    const results = await new AxeBuilder({ page: popup }).setLegacyMode().analyze();
    expect(results.violations).toEqual([]);
  });
});
