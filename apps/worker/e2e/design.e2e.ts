// The design (plan, "Design"): the pages reflow at 320 px, pass axe in both color schemes, load
// their stylesheets and fonts under the CSP, and let a signed-in user sign out without
// JavaScript.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { INVALID_LINK, openRefusalPage } from "./rejected-save-pages.ts";
import { saveThroughForm } from "./save-through-form.ts";
import { ADDRESS_FORM_STATES, bringAddressFormTo, holdLookups } from "./held-lookups.ts";
import { saveFailed, saveHeld } from "./review-items.ts";
import { openWarnedForm, sendWithoutTheBox } from "./sensitivity-warning.ts";

// One unbroken word, with no hyphen or slash a line could break at, so only `overflow-wrap` can
// keep it inside the page (#33). The address is under the 2,048-character cap, and the title at
// the 200-character cap.
const LONG_URL = `https://example.com/${"longpathwithoutabreak".repeat(70)}`;
const LONG_TITLE = "T".repeat(200);

function saveUrl(values: Record<string, string>): string {
  return `/save?${new URLSearchParams(values).toString()}`;
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

// The save links that sign-in returns to after a save whose session had ended (#34): with the
// values the user entered, and with the note that they did not fit in the link.
const RETURNED_FORMS = [
  ["with what was entered", { confirmed_title: LONG_TITLE, confirmed_description: "My notes" }],
  ["without what was entered", { confirmed_values: "not-kept" }],
] as const;

async function rejectTitle(page: Page): Promise<void> {
  // Only spaces pass the browser's `required` check and fail on the server, after trimming.
  await page.getByLabel("Title").fill("   ");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveTitle("Check the form - Haystack");
  // The title comes before the stylesheets in the page's head, so it can match while they are
  // still loading, and a test that reads layout right after the match sees the unstyled page
  // (#159).
  await page.waitForLoadState("load");
}

async function openDeleteDialog(page: Page, url: string, title: string): Promise<void> {
  await saveThroughForm(page, url, title);
  await page.goto("/");
  await page.getByRole("button", { name: `Delete ${title}` }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("at a 320 px viewport, nothing scrolls horizontally", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("the signed-out page", async ({ page }) => {
    await page.goto("/auth/signed-out");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test.describe("signed in", () => {
    test.beforeEach(async ({ signIn }) => {
      await signIn();
    });

    test("the save form with a long address", async ({ page }) => {
      await page.goto(saveUrl({ url: LONG_URL }));
      await expect(page.getByText(LONG_URL)).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    test("the save form after a rejected title", async ({ page }) => {
      await page.goto(saveUrl({ url: LONG_URL }));
      await rejectTitle(page);
      await expectNoHorizontalScroll(page);
    });

    // The warning that the link might be private, and its checkbox (#132).
    test("the save form with the warning, and after a submission without the box", async ({
      page,
      jev,
    }) => {
      await openWarnedForm(page, jev, LONG_URL);
      await expectNoHorizontalScroll(page);
      await sendWithoutTheBox(page, jev, LONG_URL);
      await expectNoHorizontalScroll(page);
    });

    for (const [state, returned] of RETURNED_FORMS) {
      test(`the save form after sign-in, ${state}`, async ({ page }) => {
        await page.goto(saveUrl({ url: LONG_URL, ...returned }));
        await expect(page).toHaveTitle("Not saved yet - Haystack");
        await page.waitForLoadState("load");
        await expectNoHorizontalScroll(page);
      });
    }

    test("the saved links page with the address form", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("textbox", { name: "Save a link" })).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    // The rejected address is put back in the field, where it scrolls inside the field.
    // Each state the address form's script leaves the form in (#105), on both forms: a message
    // under the row, a changed label on Continue, or the error above the field.
    for (const state of ADDRESS_FORM_STATES) {
      test(`the address form showing ${state}`, async ({ page, pages }) => {
        if (state === "a timeout") {
          await page.clock.install();
        }
        const lookups = await holdLookups(page);
        for (const [index, path] of ["/", "/save"].entries()) {
          await page.goto(path);
          const address = pages.url(`/${"longpathwithoutabreak".repeat(20)}`);
          await bringAddressFormTo(page, lookups, index, state, address);
          await expectNoHorizontalScroll(page);
        }
      });
    }

    test("the address form after a rejected long address", async ({ page }) => {
      const url = LONG_URL.replace("https:", "http:");
      await page.goto(saveUrl({ url }));
      await expect(page.getByRole("textbox", { name: "Save a link" })).toHaveValue(url);
      await expectNoHorizontalScroll(page);
    });

    // A host is one label up to 63 characters long, so the longest has no break inside it either.
    test("the review page with a long title and host on each kind of card", async ({
      page,
      run,
    }) => {
      const host = `${"h".repeat(63)}.example.com`;
      await saveHeld(page, run, `https://${host}/reflow-held`, LONG_TITLE);
      await saveFailed(page, run, `https://${host}/reflow-failed`, `${LONG_TITLE.slice(1)}F`);
      await page.goto("/held");
      await expect(page.getByText(host)).toHaveCount(2);
      await expectNoHorizontalScroll(page);
    });

    test("the recent saves list with a long address and title, and its delete dialog", async ({
      page,
    }) => {
      await openDeleteDialog(page, `${LONG_URL}/reflow-list`, LONG_TITLE);
      await expectNoHorizontalScroll(page);
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByText(`${LONG_URL}/reflow-list`)).toBeVisible();
      await expectNoHorizontalScroll(page);
    });
  });
});

// The palette follows the system's color scheme. Each scan first checks that the page uses
// that scheme's ground color, so axe's contrast checks ran against the right palette.
for (const [colorScheme, ground] of [
  ["dark", "rgb(18, 20, 23)"],
  ["light", "rgb(246, 244, 239)"],
] as const) {
  test.describe(`in the ${colorScheme} color scheme, axe finds no violations on`, () => {
    test.use({ colorScheme });

    async function expectNoViolations(page: Page): Promise<void> {
      await expect(page.locator("body")).toHaveCSS("background-color", ground);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }

    test("the signed-out page", async ({ page }) => {
      await page.goto("/auth/signed-out");
      await expectNoViolations(page);
    });

    // /auth/* routes never look up a session, so this is the not-found page's signed-out form.
    test("the signed-out not-found page", async ({ page }) => {
      await page.goto("/auth/nowhere");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
      await expectNoViolations(page);
    });

    test.describe("signed in", () => {
      test.beforeEach(async ({ signIn }) => {
        await signIn();
      });

      test("the signed-in not-found page", async ({ page }) => {
        await page.goto("/nowhere");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
        await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
        await expectNoViolations(page);
      });

      test("the empty saved links list", async ({ page }) => {
        await page.goto("/");
        await expect(page.getByText("You haven't saved any links yet.")).toBeVisible();
        await expectNoViolations(page);
      });

      test("the saved confirmation, then the already saved page", async ({ page }) => {
        const url = `https://example.com/saved-${colorScheme}`;
        // It ends on the page that confirms the save.
        await saveThroughForm(page, url, "A saved guide");
        await expectNoViolations(page);
        await page.goto(saveUrl({ url }));
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          "You already saved this link",
        );
        await expectNoViolations(page);
      });

      // The page a browser without JavaScript gets from a Delete button. axe runs in the page, so
      // it cannot scan with JavaScript disabled. form.submit() skips the dialog script's submit
      // listener, which is what a browser without JavaScript does.
      test("the delete confirmation page", async ({ page }) => {
        await saveThroughForm(page, `https://example.com/confirm-${colorScheme}`, "A guide");
        await page.goto("/");
        await page
          .getByRole("button", { name: "Delete A guide" })
          .evaluate((button) => button.closest("form")?.submit());
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Delete this link?");
        await expectNoViolations(page);
      });

      test("the save form", async ({ page }) => {
        await page.goto(saveUrl({ url: "https://example.com/article", og_title: "An article" }));
        await expectNoViolations(page);
      });

      test("the save form after a rejected title", async ({ page }) => {
        await page.goto(saveUrl({ url: "https://example.com/article", og_title: "An article" }));
        await rejectTitle(page);
        await expectNoViolations(page);
      });

      // The warning that the link might be private, its checkbox ticked, and the form after a
      // submission without it (#132).
      test("the save form with the warning, and after a submission without the box", async ({
        page,
        jev,
      }) => {
        const url = "https://example.com/axe-warning";
        await openWarnedForm(page, jev, url);
        await expectNoViolations(page);
        await page.getByRole("checkbox").check();
        await expectNoViolations(page);
        await sendWithoutTheBox(page, jev, url);
        await expectNoViolations(page);
      });

      // The form that sign-in returns to after a save whose session had ended (#34).
      for (const [state, returned] of RETURNED_FORMS) {
        test(`the save form after sign-in, ${state}`, async ({ page }) => {
          await page.goto(saveUrl({ url: "https://example.com/article", ...returned }));
          await expect(page).toHaveTitle("Not saved yet - Haystack");
          await expectNoViolations(page);
        });
      }

      test("the empty review page", async ({ page }) => {
        await page.goto("/held");
        await expect(page.getByText("Nothing to review.")).toBeVisible();
        await expectNoViolations(page);
      });

      // Each kind of card, a ticked checkbox, the saved links page's link to /held, the result
      // of an action, and the delete dialog.
      test("the review page and the link to it", async ({ page, run }) => {
        await saveHeld(page, run, `https://example.com/axe-held-${colorScheme}`, "Held guide");
        await saveHeld(page, run, `https://example.com/axe-held-2-${colorScheme}`, "Other guide");
        await saveFailed(
          page,
          run,
          `https://example.com/axe-failed-${colorScheme}`,
          "Failed guide",
        );
        await page.goto("/");
        await expect(page.getByRole("link", { name: "Review 3 links" })).toBeVisible();
        await expectNoViolations(page);

        await page.goto("/held");
        await page.getByRole("checkbox").first().check();
        await expectNoViolations(page);
        await page.getByRole("button", { name: "Retry Failed guide" }).click();
        await expect(page.locator("#list-status > p")).toHaveText(/^Retrying “Failed guide”\./);
        await page.waitForLoadState("load");
        await expectNoViolations(page);
        await page.getByRole("button", { name: "Delete Held guide" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await expectNoViolations(page);
      });

      test("the recent saves list with the delete dialog open", async ({ page }) => {
        await openDeleteDialog(page, `https://example.com/axe-${colorScheme}`, "A guide");
        await expectNoViolations(page);
      });

      // A rejected address gets the address form (#97), so these pages are reached the ways
      // that remain: a link whose title is over its cap, and a tampered POST.
      test("the validation and refusal pages", async ({ page }) => {
        await page.goto(INVALID_LINK);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          "This link can't be saved",
        );
        await expectNoViolations(page);
        await openRefusalPage(page);
        await expectNoViolations(page);
      });

      test("the address form on a bare /save", async ({ page }) => {
        await page.goto("/save");
        await expect(page.getByRole("textbox", { name: "Save a link" })).toBeVisible();
        await expectNoViolations(page);
      });

      test("the address form after a rejected address, and after a flagged one", async ({
        page,
      }) => {
        for (const url of ["http://example.com/axe", "https://example.com/?access_token=secret"]) {
          await page.goto(saveUrl({ url }));
          await expect(page).toHaveTitle("Check the address - Haystack");
          await expectNoViolations(page);
        }
      });

      // Each state the address form's script leaves the form in (#105), on both forms.
      for (const state of ADDRESS_FORM_STATES) {
        test(`the address form showing ${state}`, async ({ page, pages }) => {
          if (state === "a timeout") {
            await page.clock.install();
          }
          const lookups = await holdLookups(page);
          for (const [index, path] of ["/", "/save"].entries()) {
            await page.goto(path);
            await bringAddressFormTo(page, lookups, index, state, pages.url("/axe-state"));
            await expectNoViolations(page);
          }
        });
      }
    });
  });
}

test.describe("the stylesheets and fonts load under the CSP", () => {
  test.beforeEach(async ({ page }) => {
    // Registered before any page script runs, so no violation is missed.
    await page.addInitScript(() => {
      const violations: string[] = [];
      Object.assign(window, { cspViolations: violations });
      document.addEventListener("securitypolicyviolation", (event) => {
        violations.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
  });

  for (const [name, path] of [
    ["the signed-out page", "/auth/signed-out"],
    ["the save form", saveUrl({ url: "https://example.com/fonts", og_title: "Fonts" })],
  ] as const) {
    test(`on ${name}`, async ({ page, signIn, baseURL }) => {
      await signIn();
      const errors: string[] = [];
      const offOrigin: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          errors.push(message.text());
        }
      });
      page.on("request", (request) => {
        if (new URL(request.url()).origin !== baseURL) {
          offOrigin.push(request.url());
        }
      });
      await page.goto(path);

      // The browser default is a serif font on a white or transparent background.
      await expect(page.locator("body")).toHaveCSS("font-family", /^"Space Grotesk"/);
      await expect(page.locator("body")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      const loaded = await page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts]
          .filter((face) => face.status === "loaded")
          .map((face) => face.family.replaceAll('"', ""));
      });
      expect(loaded).toContain("Space Grotesk");
      if (path.startsWith("/save")) {
        // The address is set in the monospace font.
        expect(loaded).toContain("JetBrains Mono");
      }
      expect(
        await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations),
      ).toEqual([]);
      expect(errors).toEqual([]);
      expect(offOrigin).toEqual([]);
    });
  }
});

// The dialog sits inside <main>, whose children are spaced with margins, so this catches a
// margin that replaces the browser's centering of a modal dialog.
for (const viewport of [
  { width: 1280, height: 900 },
  { width: 320, height: 640 },
]) {
  test.describe(`at ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });

    test("the open delete dialog is centered", async ({ page, signIn }) => {
      await signIn();
      await openDeleteDialog(page, `https://example.com/centered-${viewport.width}`, "A guide");
      const box = await page.getByRole("dialog").boundingBox();
      if (box === null) {
        throw new Error("The open dialog has no box");
      }
      const below = viewport.height - (box.y + box.height);
      const right = viewport.width - (box.x + box.width);
      expect(Math.abs(box.y - below)).toBeLessThanOrEqual(2);
      expect(Math.abs(box.x - right)).toBeLessThanOrEqual(2);
    });
  });
}

// The design puts Continue next to the field, and under it when the row has no room for both.
for (const [width, beside] of [
  [1280, true],
  [320, false],
] as const) {
  test.describe(`at ${width} px wide`, () => {
    test.use({ viewport: { width, height: 800 } });

    test(`Continue is ${beside ? "next to" : "under"} the address field`, async ({
      page,
      signIn,
    }) => {
      await signIn();
      await page.goto("/");
      const field = await page.getByRole("textbox", { name: "Save a link" }).boundingBox();
      const button = await page.getByRole("button", { name: "Continue" }).boundingBox();
      if (field === null || button === null) {
        throw new Error("The address form is not drawn");
      }
      if (beside) {
        expect(button.y).toBeCloseTo(field.y, 0);
        expect(button.x).toBeGreaterThan(field.x + field.width);
      } else {
        expect(button.y).toBeGreaterThanOrEqual(field.y + field.height);
      }
    });
  });
}

// Forced colors, such as Windows' contrast themes, replace the palette with system colors.
test.describe("in forced colors", () => {
  test.use({ forcedColors: "active" });

  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  // The address form's script focuses its message (#105). An outline survives forced colors.
  test("the address form's focused message keeps its focus ring", async ({ page, pages }) => {
    const lookups = await holdLookups(page);
    await page.goto("/save");
    await bringAddressFormTo(page, lookups, 0, "processing", pages.url("/forced-colors-focus"));
    const message = page.locator("#save-url-status > p");
    await expect(message).toBeFocused();
    await expect(message).toHaveCSS("outline-style", "solid");
    await expect(message).toHaveCSS("outline-width", "3px");
  });

  // The checkbox is drawn in site.css, and its tick is a border, which forced colors keep.
  test("Release's ticked checkbox keeps its tick", async ({ page, run }) => {
    await saveHeld(page, run, "https://example.com/forced-colors-checkbox", "Held guide");
    await page.goto("/held");
    const checkbox = page.getByRole("checkbox");
    const tick = () =>
      checkbox.evaluate((element) => {
        const style = getComputedStyle(element, "::before");
        return { visibility: style.visibility, border: style.borderBottomStyle };
      });
    expect(await tick()).toEqual({ visibility: "hidden", border: "solid" });
    await checkbox.check();
    expect(await tick()).toEqual({ visibility: "visible", border: "solid" });
  });

  // The warning's edge and the rejected box's edge are borders, which forced colors keep, while
  // the warning's raised background is dropped (#132).
  test("the save form's warning keeps its edge, and the rejected box its edge and tick", async ({
    page,
    jev,
  }) => {
    await sendWithoutTheBox(page, jev, "https://example.com/forced-colors-warning");
    await expect(page.locator("#sensitivity-warning")).toHaveCSS("border-left-style", "solid");
    await expect(page.locator("#sensitivity-warning")).toHaveCSS("border-left-width", "4px");
    const checkbox = page.getByRole("checkbox");
    await expect(checkbox).toHaveCSS("border-top-style", "solid");
    await checkbox.check();
    expect(
      await checkbox.evaluate((element) => getComputedStyle(element, "::before").visibility),
    ).toBe("visible");
  });

  test("only the current page's link is outlined and underlined", async ({ page }) => {
    const savedLinks = page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Saved links" });
    await page.goto("/");
    await expect(savedLinks).toHaveCSS("border-top-style", "solid");
    await expect(savedLinks).toHaveCSS("text-decoration-line", "underline");
    await page.goto(saveUrl({ url: "https://example.com/forced-colors" }));
    await expect(savedLinks).toHaveCSS("border-top-style", "none");
  });

  test("the alert's icon keeps its glyph and circle, and adds nothing to what is read", async ({
    page,
  }) => {
    await page.goto(saveUrl({ url: "https://example.com/forced-colors-alert" }));
    await rejectTitle(page);
    const alert = page.getByRole("alert");
    const icon = await alert.evaluate((element) => {
      const style = getComputedStyle(element, "::before");
      return { content: style.content, border: style.borderTopStyle };
    });
    // Text and borders keep forced colors, while a drawn background would be dropped.
    expect(icon.content).toContain('"!"');
    expect(icon.border).toBe("solid");
    // Playwright's aria snapshot leaves generated content out, so the check reads Chromium's own
    // accessibility tree, where "!" would be a text node if it had no empty alternative.
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    await cdp.detach();
    const texts = nodes
      .filter((node) => node.role?.value === "StaticText")
      .map((node) => String(node.name?.value ?? "").trim());
    expect(texts).toContain("Enter a title of up to 200 characters.");
    expect(texts).not.toContain("!");
  });
});

test.describe("the header", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("marks Saved links as the current page on the list only", async ({ page }) => {
    const savedLinks = page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Saved links" });
    await page.goto("/");
    await expect(savedLinks).toHaveAttribute("aria-current", "page");
    await page.goto(saveUrl({ url: "https://example.com/current" }));
    await expect(savedLinks).not.toHaveAttribute("aria-current");
  });

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("Sign out ends the session and shows the signed-out page", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "You are signed out of Haystack",
      );
      // The fixture keeps sending the old session cookie, which the Worker no longer accepts.
      // No redirect is followed, so nothing goes to Google.
      const response = await page.request.get("/", {
        headers: { accept: "text/html" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(302);
      expect(response.headers().location).toBe("/auth/sign-in?return_to=%2F");
    });
  });
});
