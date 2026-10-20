// The "Save a link" address form (#97): the keyboard path from the saved links page and from a
// bare /save to the save form, filled in from the page the Worker looks up (#105). With
// JavaScript, address-form.js sends the form with `fetch` and handles each answer in the page;
// without it, the browser posts the form and follows the 303. Each numbered test is one point of
// the design, as the plan's "Testing strategy" lists them. axe and reflow at 320 px run in
// design.e2e.ts with the other pages.
import type { Page } from "@playwright/test";
import type { PageFixture } from "../test/page-fixture.ts";
import { expect, test } from "./fixtures.ts";
import { holdLookups, installPausedClock, MESSAGES, PROCESSING_LABEL } from "./held-lookups.ts";

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

function field(page: Page) {
  return page.getByRole("textbox", { name: "Save a link" });
}

/** The message in the status region, which the script focuses. */
function message(page: Page) {
  return page.locator("#save-url-status > p");
}

function status(page: Page) {
  return page.locator("#save-url-status");
}

/** Continue as it is when the form is ready: its own label, and never disabled. */
async function expectReady(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Continue" });
  await expect(button).toBeVisible();
  await expect(button).not.toHaveAttribute("aria-disabled");
  await expect(button).toBeEnabled();
}

/** Continue while a lookup runs: the processing label, still never disabled, and the message. */
async function expectProcessing(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: PROCESSING_LABEL });
  await expect(button).toBeVisible();
  await expect(button).not.toHaveAttribute("aria-disabled");
  await expect(button).toBeEnabled();
  await expect(status(page)).toHaveRole("status");
  await expect(status(page)).toHaveText(MESSAGES.processing);
}

const ADDRESS_RULE =
  "Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long.";
const SECRET_REASON =
  "This link contains an access token, key, or password, so it could let anyone who has it act as you.";
const HINT = "Paste the address of a page. You confirm its title on the next step.";

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

test.describe("1. without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the form posts, and the browser follows the 303 to the save form", async ({
    page,
    pages,
  }) => {
    const address = pageAbout(pages, "/no-script", "No script");
    await page.goto("/save");
    await field(page).fill(address);
    const post = page.waitForRequest((request) => request.url().endsWith("/save/address"));
    await page.getByRole("button", { name: "Continue" }).click();
    const request = await post;
    expect(request.method()).toBe("POST");
    expect(request.resourceType()).toBe("document");
    await expectSaveFormFor(page, address, "No script");
  });

  test("a rejected address gets the server's page with the same error as with JavaScript", async ({
    page,
  }) => {
    await page.goto("/save");
    await field(page).fill("pages.test/no-scheme");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveTitle("Check the address - Haystack");
    await expect(page.getByRole("alert")).toHaveText(ADDRESS_RULE);
    await expect(field(page)).toHaveAccessibleDescription(`${ADDRESS_RULE} ${HINT}`);
    await expect(field(page)).toHaveValue("pages.test/no-scheme");
  });
});

test("2. with JavaScript, the form goes through fetch to the same route, which answers JSON", async ({
  page,
  pages,
}) => {
  const address = pageAbout(pages, "/with-script", "With script");
  await page.goto("/save");
  await field(page).fill(address);
  const answer = page.waitForResponse((response) => response.url().endsWith("/save/address"));
  await page.getByRole("button", { name: "Continue" }).click();
  const response = await answer;
  const request = response.request();
  expect(request.method()).toBe("POST");
  expect(request.resourceType()).toBe("fetch");
  expect(await request.headerValue("accept")).toBe("application/json");
  expect(new URLSearchParams(request.postData() ?? "").get("url")).toBe(address);
  expect(response.headers()["content-type"]).toBe("application/json; charset=utf-8");
  await expectSaveFormFor(page, address, "With script");
});

test.describe("while a lookup runs", () => {
  test("3. Continue is never disabled: its label says Processing…, and the processing message takes focus", async ({
    page,
    pages,
  }) => {
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await tabToField(page);
    await page.keyboard.type(pages.url("/processing"));
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await lookups.next(1);
    await expectProcessing(page);
    await expect(message(page)).toBeFocused();
    // The site's focus ring, from the tokens.
    await expect(message(page)).toHaveCSS("outline-style", "solid");
    await expect(message(page)).toHaveCSS("outline-width", "3px");
  });

  test("3. pressing Enter in the field moves focus to the processing message too", async ({
    page,
    pages,
  }) => {
    const lookups = await holdLookups(page);
    await page.goto("/");
    await tabToField(page);
    await page.keyboard.type(pages.url("/processing-field"));
    await page.keyboard.press("Enter");
    await lookups.next(1);
    await expectProcessing(page);
    await expect(message(page)).toBeFocused();
  });

  // A user who moves elsewhere before the message is written keeps their place.
  test("3. the processing message does not take focus from a user who moved away first", async ({
    page,
    pages,
  }) => {
    await installPausedClock(page);
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/moved-away"));
    await field(page).press("Enter");
    await lookups.next(1);
    const elsewhere = page.getByRole("link", { name: "Saved links" });
    await elsewhere.focus();
    await page.clock.fastForward(100);
    await expectProcessing(page);
    await expect(elsewhere).toBeFocused();
  });

  test("4. a second press with the same address is ignored, and sends no second request", async ({
    page,
    pages,
  }) => {
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/same"));
    await field(page).press("Enter");
    await lookups.next(1);
    await expect(message(page)).toBeFocused();
    // Enter from the field, which the keyboard reaches back from the message, and a click.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(field(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: PROCESSING_LABEL }).click();
    await expectProcessing(page);
    expect(lookups.all).toHaveLength(1);
    expect(lookups.all[0]?.aborted()).toBe(false);
  });

  test("4. a press with the same address while its save form loads is ignored, and sends no second request", async ({
    page,
    pages,
  }) => {
    const lookups = await holdLookups(page);
    // A 204 keeps the browser on this page, as a save form that is slow to load does.
    let opened = 0;
    await page.route(
      (url) => url.pathname === "/save" && url.search !== "",
      async (route) => {
        opened += 1;
        await route.fulfill({ status: 204 });
      },
    );
    await page.goto("/save");
    const address = pages.url("/leaving");
    await field(page).fill(address);
    await field(page).press("Enter");
    await (
      await lookups.next(1)
    ).answer(200, { saveLink: `/save?${new URLSearchParams({ url: address }).toString()}` });
    await expect.poll(() => opened).toBe(1);
    // Playwright's locators and their assertions wait for a navigation to finish, and a 204 never
    // does, so the presses go through the page's keyboard, and focus is read in the page: Enter
    // on Continue, then Enter in the field.
    const focused = () =>
      page.evaluate(() => {
        const active = document.activeElement;
        if (active?.closest("#save-url-status")) {
          return "message";
        }
        return active?.id === "save-url" ? "field" : (active?.textContent ?? "");
      });
    await expect.poll(focused).toBe("message");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(focused).toBe(PROCESSING_LABEL);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(focused).toBe("field");
    await page.keyboard.press("Enter");
    // Long enough for a second request to reach the route if one were sent.
    await page.waitForTimeout(200);
    expect(lookups.all).toHaveLength(1);
  });

  test("5. a click with a changed address aborts the request in flight and sends a new one, and the late answer is ignored", async ({
    page,
    pages,
  }) => {
    const second = pageAbout(pages, "/changed", "Changed");
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/first"));
    await field(page).press("Enter");
    const first = await lookups.next(1);
    await field(page).fill(second);
    await page.getByRole("button", { name: PROCESSING_LABEL }).click();
    const replacement = await lookups.next(2);
    expect(replacement.address).toBe(second);
    await expect.poll(() => first.aborted()).toBe(true);
    // The first request's answer, had it come, says nothing: the form waits for the second.
    await first.answer(400, { error: "A late answer", keepValue: false });
    await expectProcessing(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await replacement.release();
    await expectSaveFormFor(page, second, "Changed");
  });

  test("5. moving back from the message to the field, changing the address and pressing Enter sends the new address", async ({
    page,
    pages,
  }) => {
    const second = pageAbout(pages, "/changed-by-keyboard", "Changed by keyboard");
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/first-by-keyboard"));
    await field(page).press("Enter");
    const first = await lookups.next(1);
    await expect(message(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(field(page)).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(second);
    await page.keyboard.press("Enter");
    const replacement = await lookups.next(2);
    expect(replacement.address).toBe(second);
    await expect.poll(() => first.aborted()).toBe(true);
    await replacement.release();
    await expectSaveFormFor(page, second, "Changed by keyboard");
  });

  // A browser can restore the page from its back-forward cache as it was left, still processing.
  // Playwright's Chromium does not show whether it used the cache, so the event the browser fires
  // for a restored page is dispatched here.
  test("9. a page restored from the back-forward cache is ready, its message gone and nothing focused", async ({
    page,
    pages,
  }) => {
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/restored"));
    await field(page).press("Enter");
    await lookups.next(1);
    await expectProcessing(page);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await expectReady(page);
    await expect(status(page)).toBeEmpty();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });
});

test("6. on success, the browser goes to the save link with its fields", async ({
  page,
  pages,
}) => {
  const address = pageAbout(pages, "/success", "Success");
  await page.goto("/");
  await field(page).fill(address);
  await field(page).press("Enter");
  await page.waitForURL((url) => url.pathname === "/save" && url.searchParams.has("og_title"));
  const query = new URL(page.url()).searchParams;
  expect(Object.fromEntries(query)).toEqual({
    url: address,
    title: "Success - Example",
    description: "About Success.",
    og_title: "Success",
  });
  await expectSaveFormFor(page, address, "Success");
});

test.describe("6. a save link that is not this origin's save form is not followed", () => {
  for (const [kind, saveLink] of [
    ["on another origin", "https://evil.test/save?url=https%3A%2F%2Fpages.test%2F"],
    ["on another path", "/elsewhere?url=https%3A%2F%2Fpages.test%2F"],
  ] as const) {
    test(`a link ${kind}`, async ({ page, pages }) => {
      const lookups = await holdLookups(page);
      await page.goto("/save");
      await field(page).fill(pages.url("/odd-link"));
      await field(page).press("Enter");
      await (await lookups.next(1)).answer(200, { saveLink });
      await expect(status(page)).toHaveText(MESSAGES.unexpected);
      // The failure message replaces the processing message, and takes its focus.
      await expect(message(page)).toBeFocused();
      expect(new URL(page.url()).pathname).toBe("/save");
      await expectReady(page);
    });
  }
});

test.describe("7. a rejected address", () => {
  test("shows the server's error markup, and the field gets focus, reading the error, then the hint", async ({
    page,
  }) => {
    await page.goto("/");
    await field(page).fill("pages.test/no-scheme");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(field(page)).toBeFocused();
    await expect(page.getByRole("alert")).toHaveText(ADDRESS_RULE);
    await expect(page.locator(".alert[role=alert] > p#save-url-error")).toHaveText(ADDRESS_RULE);
    await expect(field(page)).toHaveAttribute("aria-invalid", "true");
    await expect(field(page)).toHaveAttribute("aria-describedby", "save-url-error save-url-hint");
    await expect(field(page)).toHaveAccessibleDescription(`${ADDRESS_RULE} ${HINT}`);
    // The typed value stays, so it can be corrected.
    await expect(field(page)).toHaveValue("pages.test/no-scheme");
    await expectReady(page);
    expect(new URL(page.url()).pathname).toBe("/");
  });

  // The server's error page is titled "Check the address", and the title is what VoiceOver says
  // first on a new page, so the page in place takes the same title, and gives it back when the
  // error goes.
  test("gives the page the error page's title, and gives the title back when the error goes", async ({
    page,
    pages,
  }) => {
    const lookups = await holdLookups(page);
    await page.goto("/");
    await expect(page).toHaveTitle("Saved links - Haystack");
    await field(page).fill("pages.test/no-scheme");
    await field(page).press("Enter");
    await (await lookups.next(1)).release();
    await expect(page.getByRole("alert")).toHaveText(ADDRESS_RULE);
    await expect(page).toHaveTitle("Check the address - Haystack");
    // A new request clears the error, and with it the title.
    await field(page).fill(pages.url("/title-back"));
    await field(page).press("Enter");
    await lookups.next(2);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page).toHaveTitle("Saved links - Haystack");
  });

  test("that carries a secret is not put back in the field", async ({ page, pages }) => {
    await page.goto("/save");
    await field(page).fill(pages.url("/cb?access_token=secret-value"));
    await field(page).press("Enter");
    await expect(page.getByRole("alert")).toHaveText(SECRET_REASON);
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue("");
    await expect(field(page)).toHaveAccessibleDescription(`${SECRET_REASON} ${HINT}`);
    expect(await page.locator("body").innerHTML()).not.toContain("secret-value");
    expect(pages.requests.filter((request) => request.path.startsWith("/cb"))).toHaveLength(0);
  });

  test("is corrected in place: the error goes when the corrected address is sent", async ({
    page,
    pages,
  }) => {
    const address = pageAbout(pages, "/corrected", "Corrected");
    await page.goto("/save");
    await field(page).fill(address.replace("https://", ""));
    await field(page).press("Enter");
    await expect(page.getByRole("alert")).toHaveText(ADDRESS_RULE);
    await page.keyboard.press("Home");
    await page.keyboard.type("https://");
    await page.keyboard.press("Enter");
    await expectSaveFormFor(page, address, "Corrected");
  });

  test("on a page that already shows the server's error replaces it, rather than adding one", async ({
    page,
  }) => {
    await page.goto(`/save?${new URLSearchParams({ url: "http://pages.test/a" }).toString()}`);
    await expect(page.getByRole("alert")).toHaveText(ADDRESS_RULE);
    await field(page).fill("");
    await field(page).press("Enter");
    await expect(page.getByRole("alert")).toHaveText(
      "Enter the address of a page, starting with https://.",
    );
    await expect(page.getByRole("alert")).toHaveCount(1);
  });
});

test.describe("8. a lookup that fails leaves the form ready to try again", () => {
  async function expectTryAgain(
    page: Page,
    lookups: Awaited<ReturnType<typeof holdLookups>>,
  ): Promise<void> {
    await expectReady(page);
    await field(page).press("Enter");
    await lookups.next(2);
    await expectProcessing(page);
  }

  test("a timeout after 10 s says so", async ({ page, pages }) => {
    await page.clock.install();
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/never"));
    await field(page).press("Enter");
    await lookups.next(1);
    await page.clock.fastForward(9_000);
    await expectProcessing(page);
    await page.clock.fastForward(1_200);
    await expect(status(page)).toHaveText(MESSAGES.timeout);
    // The failure message replaces the processing message, and takes its focus.
    await expect(message(page)).toBeFocused();
    await expect.poll(() => lookups.all[0]?.aborted()).toBe(true);
    // The clock is the test's, so the processing message waits for it to move on.
    await expectReady(page);
    await field(page).press("Enter");
    await lookups.next(2);
    await page.clock.fastForward(100);
    await expectProcessing(page);
  });

  // The failure message waits 100 ms, as the processing message does. Until then the processing
  // message stays, with focus, so focus never falls to the page in between.
  test("the failure message replaces the processing message, which keeps focus until then", async ({
    page,
    pages,
  }) => {
    await installPausedClock(page);
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/replaced"));
    await field(page).press("Enter");
    const lookup = await lookups.next(1);
    await page.clock.fastForward(100);
    await expect(message(page)).toBeFocused();
    await lookup.fail();
    await expectReady(page);
    await expect(message(page)).toHaveText(MESSAGES.processing);
    await expect(message(page)).toBeFocused();
    await page.clock.fastForward(100);
    await expect(message(page)).toHaveText(MESSAGES.network);
    await expect(message(page)).toBeFocused();
  });

  test("a network error says so", async ({ page, pages }) => {
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/unreachable"));
    await field(page).press("Enter");
    await (await lookups.next(1)).fail();
    await expect(status(page)).toHaveText(MESSAGES.network);
    // The failure message replaces the processing message, and takes its focus.
    await expect(message(page)).toBeFocused();
    await expectTryAgain(page, lookups);
  });

  test("401, signed out, says so, with a link to sign in again", async ({ page, pages }) => {
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/signed-out"));
    await field(page).press("Enter");
    await (await lookups.next(1)).answer(401);
    await expect(status(page)).toHaveText(MESSAGES.signedOut);
    // The failure message replaces the processing message, and takes its focus.
    await expect(message(page)).toBeFocused();
    await expect(status(page).getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/auth/sign-in?return_to=%2Fsave",
    );
    await expectTryAgain(page, lookups);
  });

  test("any other answer says something went wrong", async ({ page, pages }) => {
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/odd"));
    await field(page).press("Enter");
    await (await lookups.next(1)).answer(500);
    await expect(status(page)).toHaveText(MESSAGES.unexpected);
    // The failure message replaces the processing message, and takes its focus.
    await expect(message(page)).toBeFocused();
    await expectTryAgain(page, lookups);
  });
});

test("9. going back from the save form brings back a form that is ready, not processing", async ({
  page,
  pages,
}) => {
  const address = pageAbout(pages, "/back", "Back again");
  await page.goto("/save");
  await field(page).fill(address);
  await field(page).press("Enter");
  await expectSaveFormFor(page, address, "Back again");
  await page.goBack();
  await expectReady(page);
  await expect(status(page)).toBeEmpty();
});

// Before sign-in the form asks for GET /save, which goes through sign-in and looks nothing up, so
// its page does not load the script, and even with the script added, the form is left alone.
test("the form shown before sign-in asks for GET /save, without the script", async ({
  page,
  signOut,
}) => {
  await signOut();
  await page.goto(
    `/save?${new URLSearchParams({ url: "http://pages.test/signed-out" }).toString()}`,
  );
  await expect(page).toHaveTitle("Check the address - Haystack");
  await expect(page.locator('script[src="/assets/address-form.js"]')).toHaveCount(0);
  await page.addScriptTag({ url: "/assets/address-form.js", type: "module" });
  // GET /save would send a browser with no session on to sign-in, so the navigation is answered
  // here, to show where the form went.
  await page.route(
    (url) => url.pathname === "/save",
    (route) => route.fulfill({ contentType: "text/plain", body: "GET /save" }),
  );
  await field(page).fill("https://pages.test/signed-out");
  const navigation = page.waitForRequest((request) => request.url().includes("/save?url="));
  await page.getByRole("button", { name: "Continue" }).click();
  const request = await navigation;
  expect(request.method()).toBe("GET");
  expect(request.resourceType()).toBe("document");
});

// Found in review of #105, each with the point of the design it belongs to.
test.describe("review of #105", () => {
  // The message is announced by focus, so the region is not live as well, or NVDA, JAWS and
  // TalkBack would read it twice. Without the script, nothing writes to the region.
  test("3. the status region is not live once the script runs", async ({ page }) => {
    await page.goto("/save");
    await expect(status(page)).toHaveAttribute("aria-live", "off");
    await expect(status(page)).toHaveRole("status");
  });

  test("6. the save link is followed in a browser without URL.parse", async ({ page, pages }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(URL, "parse");
    });
    const address = pageAbout(pages, "/no-url-parse", "No URL.parse");
    await page.goto("/save");
    expect(await page.evaluate(() => "parse" in URL)).toBe(false);
    await field(page).fill(address);
    await field(page).press("Enter");
    await expectSaveFormFor(page, address, "No URL.parse");
  });

  test("7. the error goes where the server puts it: before the hint in the card, before the form on its own page", async ({
    page,
  }) => {
    await page.goto("/");
    await field(page).fill("pages.test/in-card");
    await field(page).press("Enter");
    await expect(page.locator("form.address-form .alert + #save-url-hint")).toHaveCount(1);
    await page.goto("/save");
    await field(page).fill("pages.test/on-its-page");
    await field(page).press("Enter");
    await expect(page.locator(".alert + form.address-form")).toHaveCount(1);
  });

  test("7. a value that must not stay is cleared only while the field still holds it", async ({
    page,
    pages,
  }) => {
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/cb?access_token=secret-value"));
    await field(page).press("Enter");
    const lookup = await lookups.next(1);
    // The user goes on typing something else before the answer comes.
    await field(page).fill("something typed since");
    await lookup.release();
    await expect(page.getByRole("alert")).toHaveText(SECRET_REASON);
    await expect(field(page)).toHaveValue("something typed since");
  });

  // Enter from the field, then back to the field to correct the address while the lookup runs:
  // the failure's message must not take focus from the field, or the rest of the typing is lost.
  test("8. a failure message does not take focus from a user typing in the field", async ({
    page,
    pages,
  }) => {
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await field(page).fill(pages.url("/typing"));
    await field(page).press("Enter");
    const lookup = await lookups.next(1);
    await expect(message(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(field(page)).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.type("-cor");
    await lookup.fail();
    await expect(status(page)).toHaveText(MESSAGES.network);
    await page.keyboard.type("rected");
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue(`${pages.url("/typing")}-corrected`);
  });

  // A page the server rendered with an error is titled for the error. Once a new request has
  // cleared the error, it takes the page's error-free title, even when the request then fails.
  test("8. a page the server rendered with an error gets its error-free title back after a failure", async ({
    page,
    pages,
  }) => {
    const lookups = await holdLookups(page);
    await page.goto(`/save?${new URLSearchParams({ url: "http://pages.test/a" }).toString()}`);
    await expect(page).toHaveTitle("Check the address - Haystack");
    await field(page).fill(pages.url("/after-error"));
    await field(page).press("Enter");
    await (await lookups.next(1)).fail();
    await expect(status(page)).toHaveText(MESSAGES.network);
    await expect(page).toHaveTitle("Save a link - Haystack");
  });
});
