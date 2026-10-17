// The function the popup injects into the page, run in Chromium against fixture documents.
// `page.evaluate` serializes the function's source and runs it in the page, the way
// `scripting.executeScript` does, so a function that used anything from its module would fail
// here with a ReferenceError. That is what proves it is self-contained. The popup's own use of it
// is covered by toolbar-button.e2e.ts, which runs the built extension.
import { CAPTURE_CAPS, truncate, validateCapturePayload } from "@haystack/schemas";
import { expect, test as base } from "@playwright/test";
import { readPageMetadata } from "../src/read-page-metadata.ts";

const PAGE_URL = "https://fixture.test/guides/article";

interface FixturePage {
  /**
   * Serves a document with the given head at an https address, through a route, and opens it.
   * An https address gives a relative canonical URL a base to resolve against, which
   * `setContent` (a base of about:blank) does not.
   */
  (head: string, url?: string): Promise<void>;
}

// A plain browser context, because these tests never load the extension. As in fixtures.ts,
// every request must go to the fixture page, and anything else is aborted and fails the test, so
// no request leaves the machine.
const test = base.extend<{ openFixture: FixturePage }>({
  openFixture: async ({ page }, use) => {
    const unexpected: string[] = [];
    await use(async (head, url = PAGE_URL) => {
      await page.route("**/*", async (route) => {
        const requested = new URL(route.request().url());
        if (requested.href === url) {
          await route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: `<!doctype html><html lang="en"><head>${head}</head><body><p>Fixture</p></body></html>`,
          });
        } else if (
          requested.pathname === "/favicon.ico" &&
          requested.origin === new URL(url).origin
        ) {
          // Chromium asks each site for its icon.
          await route.fulfill({ status: 404 });
        } else {
          unexpected.push(requested.href);
          await route.abort("blockedbyclient");
        }
      });
      await page.goto(url);
    });
    expect(unexpected, "requests to anything but the fixture page").toEqual([]);
  },
});

// Playwright's full Chromium, as in fixtures.ts. Only the full Chromium is installed
// (`e2e:install`), not the headless shell, and the config installs nothing itself.
test.use({ channel: "chromium" });

const NOTHING = {
  canonicalUrl: null,
  description: null,
  documentTitle: "",
  ogTitle: null,
  ogDescription: null,
  ogSiteName: null,
};

test("reads null for every tag a page doesn't have", async ({ openFixture, page }) => {
  await openFixture("");

  expect(await page.evaluate(readPageMetadata)).toEqual(NOTHING);
});

test("reads every tag", async ({ openFixture, page }) => {
  await openFixture(
    `<title>Document title</title>
     <link rel="canonical" href="https://fixture.test/canonical">
     <meta name="description" content="The meta description.">
     <meta property="og:title" content="Open Graph title">
     <meta property="og:description" content="Open Graph description.">
     <meta property="og:site_name" content="Fixture Site">`,
  );

  const metadata = await page.evaluate(readPageMetadata);

  expect(metadata).toEqual({
    canonicalUrl: "https://fixture.test/canonical",
    description: "The meta description.",
    documentTitle: "Document title",
    ogTitle: "Open Graph title",
    ogDescription: "Open Graph description.",
    ogSiteName: "Fixture Site",
  });
  // What goes back to the popup is plain data.
  expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
});

test("returns values as the page wrote them, leaving trimming to the popup's validation", async ({
  openFixture,
  page,
}) => {
  await openFixture(`<meta property="og:title" content="  Padded title  ">`);

  expect((await page.evaluate(readPageMetadata)).ogTitle).toBe("  Padded title  ");
});

test.describe("several og:title tags", () => {
  test("uses the first tag that has content", async ({ openFixture, page }) => {
    await openFixture(
      `<meta property="og:title" content="First">
       <meta property="og:title" content="Second">
       <meta property="og:title" content="Third">`,
    );

    expect((await page.evaluate(readPageMetadata)).ogTitle).toBe("First");
  });

  test("skips a first tag that has no content, so it can't hide a later one", async ({
    openFixture,
    page,
  }) => {
    await openFixture(
      `<meta property="og:title" content="   ">
       <meta property="og:title">
       <meta property="og:title" content="Second">`,
    );

    expect((await page.evaluate(readPageMetadata)).ogTitle).toBe("Second");
  });
});

test.describe("Open Graph tags written with name instead of property", () => {
  test("are read, whatever the case of the attribute value", async ({ openFixture, page }) => {
    await openFixture(
      `<meta name="og:title" content="Title by name">
       <meta name="OG:Description" content="Description by name.">
       <meta property="OG:SITE_NAME" content="Site by property, in capitals">`,
    );

    expect(await page.evaluate(readPageMetadata)).toEqual({
      ...NOTHING,
      ogTitle: "Title by name",
      ogDescription: "Description by name.",
      ogSiteName: "Site by property, in capitals",
    });
  });

  test("count with property tags in document order, so the first with content wins", async ({
    openFixture,
    page,
  }) => {
    await openFixture(
      `<meta name="og:title" content="First, by name">
       <meta property="og:title" content="Second, by property">`,
    );
    expect((await page.evaluate(readPageMetadata)).ogTitle).toBe("First, by name");
  });

  test("do not hide a later property tag when they are blank", async ({ openFixture, page }) => {
    await openFixture(
      `<meta name="og:title" content="  ">
       <meta property="og:title" content="Second, by property">`,
    );
    expect((await page.evaluate(readPageMetadata)).ogTitle).toBe("Second, by property");
  });
});

test.describe("the canonical link", () => {
  test("is resolved to an absolute URL against the page", async ({ openFixture, page }) => {
    await openFixture(`<link rel="canonical" href="/articles/one?page=2">`);

    expect((await page.evaluate(readPageMetadata)).canonicalUrl).toBe(
      "https://fixture.test/articles/one?page=2",
    );
  });

  test("is resolved against the page's directory when the path has no leading slash", async ({
    openFixture,
    page,
  }) => {
    await openFixture(`<link rel="canonical" href="renamed">`);

    expect((await page.evaluate(readPageMetadata)).canonicalUrl).toBe(
      "https://fixture.test/guides/renamed",
    );
  });

  test("is resolved against a base element, the way a link would be", async ({
    openFixture,
    page,
  }) => {
    await openFixture(
      `<base href="https://cdn.fixture.test/base/"><link rel="canonical" href="one">`,
    );

    expect((await page.evaluate(readPageMetadata)).canonicalUrl).toBe(
      "https://cdn.fixture.test/base/one",
    );
  });

  test("is found whatever the case of rel, and among other rel values", async ({
    openFixture,
    page,
  }) => {
    await openFixture(`<link rel="Alternate CANONICAL" href="https://fixture.test/one">`);

    expect((await page.evaluate(readPageMetadata)).canonicalUrl).toBe("https://fixture.test/one");
  });

  test("ignores links that aren't canonical", async ({ openFixture, page }) => {
    await openFixture(
      `<link rel="alternate" href="https://fixture.test/feed">
       <link rel="canonicalize" href="https://fixture.test/almost">`,
    );

    expect((await page.evaluate(readPageMetadata)).canonicalUrl).toBeNull();
  });

  test("is null when the href is blank, which would otherwise resolve to the page itself", async ({
    openFixture,
    page,
  }) => {
    await openFixture(`<link rel="canonical" href=""><link rel="canonical" href="   ">`);

    expect((await page.evaluate(readPageMetadata)).canonicalUrl).toBeNull();
  });

  test("uses the first usable link", async ({ openFixture, page }) => {
    await openFixture(
      `<link rel="canonical" href="">
       <link rel="canonical" href="https://fixture.test/first">
       <link rel="canonical" href="https://fixture.test/second">`,
    );

    expect((await page.evaluate(readPageMetadata)).canonicalUrl).toBe("https://fixture.test/first");
  });
});

test("reads a meta description whatever the case of its name", async ({ openFixture, page }) => {
  await openFixture(`<meta name="Description" content="Capitalized name.">`);

  expect((await page.evaluate(readPageMetadata)).description).toBe("Capitalized name.");
});

test("treats values that are only whitespace as absent", async ({ openFixture, page }) => {
  await openFixture(
    `<title>   </title>
     <link rel="canonical" href="   ">
     <meta name="description" content=" &#9; &#10; ">
     <meta property="og:title" content="   ">
     <meta property="og:description" content="">
     <meta property="og:site_name" content="&nbsp;&#32;">`,
  );

  // document.title strips and collapses whitespace itself, so it is an empty string. The
  // non-breaking spaces in og:site_name count as whitespace to String.prototype.trim, which
  // is what the check uses, as they do to the schema's trim.
  expect(await page.evaluate(readPageMetadata)).toEqual(NOTHING);
});

test("returns a surrogate pair at the cap boundary whole, for the popup to truncate", async ({
  openFixture,
  page,
}) => {
  const grin = "😀";
  const title = `${"a".repeat(CAPTURE_CAPS.og_title - 1)}${grin}${"b".repeat(10)}`;
  await openFixture(`<meta property="og:title" content="${title}">`);

  const { ogTitle } = await page.evaluate(readPageMetadata);

  expect(ogTitle).toBe(title);
  // The pair starts at the last code unit the cap allows, so cutting at the cap would leave half
  // of it, and the schema would reject the title.
  const cut = truncate(ogTitle ?? "", CAPTURE_CAPS.og_title);
  expect(cut).toBe("a".repeat(CAPTURE_CAPS.og_title - 1));
  expect(validateCapturePayload({ url: PAGE_URL, og_title: cut }).ok).toBe(true);
  expect(
    validateCapturePayload({ url: PAGE_URL, og_title: title.slice(0, CAPTURE_CAPS.og_title) }).ok,
  ).toBe(false);
});
