import AxeBuilder from "@axe-core/playwright";
import { CAPTURE_CAPS, SENSITIVE_URL_EXPLANATIONS } from "@haystack/schemas";
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

function fixtureWithHead(head: string): string {
  return `<!doctype html><html lang="en"><head>${head}</head><body><p>Fixture</p></body></html>`;
}

// The plan's prefill rules ("Save flow"): the title comes from the Open Graph title, then the
// document title, then the address, and the description from the Open Graph description, then
// the meta description.
test.describe("the save form's prefill", () => {
  test("uses the Open Graph title and description, and carries every captured field", async ({
    context,
    fixturePages,
    haystackWorker,
    page,
    signIn,
    toolbar,
  }) => {
    await signIn();
    fixturePages.serve(
      ARTICLE,
      fixtureWithHead(`<title>Document title</title>
        <link rel="canonical" href="/articles/one">
        <meta name="description" content="The meta description.">
        <meta property="og:title" content="Open Graph title">
        <meta property="og:description" content="Open Graph description.">
        <meta property="og:site_name" content="Fixture Site">`),
    );
    await page.goto(ARTICLE);

    const saveForm = context.waitForEvent("page", {
      predicate: (opened) => opened.url().startsWith(`${haystackWorker.origin}/save?`),
    });
    await toolbar.click(page);
    const form = await saveForm;

    // The names are the ones /save reads, and the canonical URL is the absolute one.
    await expect(form).toHaveURL(
      `${haystackWorker.origin}/save?${new URLSearchParams({
        url: ARTICLE,
        canonical_url: "https://fixture.test/articles/one",
        title: "Document title",
        description: "The meta description.",
        og_title: "Open Graph title",
        og_description: "Open Graph description.",
        og_site_name: "Fixture Site",
      })}`,
    );
    await expect(form.getByLabel("Title")).toHaveValue("Open Graph title");
    await expect(form.getByLabel("Description")).toHaveValue("Open Graph description.");
    // The raw values travel on to POST /save as hidden inputs.
    await expect(form.locator('input[name="canonical_url"]')).toHaveValue(
      "https://fixture.test/articles/one",
    );
    await expect(form.locator('input[name="og_site_name"]')).toHaveValue("Fixture Site");
  });

  test("falls back to the document title and the meta description without Open Graph tags", async ({
    context,
    fixturePages,
    haystackWorker,
    page,
    signIn,
    toolbar,
  }) => {
    await signIn();
    fixturePages.serve(
      ARTICLE,
      fixtureWithHead(`<title>Document title</title>
        <meta name="description" content="The meta description.">`),
    );
    await page.goto(ARTICLE);

    const saveForm = context.waitForEvent("page", {
      predicate: (opened) => opened.url().startsWith(`${haystackWorker.origin}/save?`),
    });
    await toolbar.click(page);
    const form = await saveForm;

    await expect(form.getByLabel("Title")).toHaveValue("Document title");
    await expect(form.getByLabel("Description")).toHaveValue("The meta description.");
  });

  test("falls back to the address, with an empty description, on a page with no tags", async ({
    context,
    fixturePages,
    haystackWorker,
    page,
    signIn,
    toolbar,
  }) => {
    await signIn();
    fixturePages.serve(ARTICLE, fixtureWithHead(""));
    await page.goto(ARTICLE);

    const saveForm = context.waitForEvent("page", {
      predicate: (opened) => opened.url().startsWith(`${haystackWorker.origin}/save?`),
    });
    await toolbar.click(page);
    const form = await saveForm;

    await expect(form.getByLabel("Title")).toHaveValue(ARTICLE);
    await expect(form.getByLabel("Description")).toHaveValue("");
  });

  test("cuts an over-long Open Graph title to its cap, so the page is still saved", async ({
    context,
    fixturePages,
    haystackWorker,
    page,
    signIn,
    toolbar,
  }) => {
    await signIn();
    const grin = "😀";
    // The pair starts at the last code unit the cap allows, so it can't be kept whole.
    const title = `${"a".repeat(CAPTURE_CAPS.og_title - 1)}${grin}tail`;
    fixturePages.serve(ARTICLE, fixtureWithHead(`<meta property="og:title" content="${title}">`));
    await page.goto(ARTICLE);

    const saveForm = context.waitForEvent("page", {
      predicate: (opened) => opened.url().startsWith(`${haystackWorker.origin}/save?`),
    });
    await toolbar.click(page);
    const form = await saveForm;

    await expect(form.getByLabel("Title")).toHaveValue("a".repeat(CAPTURE_CAPS.og_title - 1));
  });
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
