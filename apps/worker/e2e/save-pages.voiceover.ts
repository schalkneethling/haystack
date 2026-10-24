// What VoiceOver says on the save pages that report a problem: the page for an invalid link,
// the refusal page for a link with a secret in it, the save form after a rejected title, and the
// address form after a rejected address (#97).
// Each check matches one part of a phrase, ignoring case, and the parts must come in the order
// the user hears them. A change in how VoiceOver words a role fails the test and is worth
// reviewing.
//
// VoiceOver does not speak a page title when a script loads the page. It speaks it when the user
// enters the web content ("In <title> web content") and when a page loads after the user's own
// action, so the tests do the same. On the save link pages, the tests leave and enter the web
// content, and check the title as the web content's name, which is what VoiceOver says. The error
// paragraph on the form is not a live announcement either: it is in the page when it loads, so
// the user reaches it by moving to it. The field reads the error as its description, which works
// only because the field points at a plain paragraph inside the alert, not at the alert itself
// (see "Save flow" in the plan).
//
// Since #97, GET /save shows the address form for a rejected address, so the validation page is
// reached with a title over its cap, and the refusal page with a tampered POST.
import type { VoiceOverPlaywright } from "@guidepup/playwright";
import { INVALID_LINK, openRefusalPage } from "./rejected-save-pages.ts";
import { expect, test } from "./voiceover-fixtures.ts";

function saveUrl(values: Record<string, string>): string {
  return `/save?${new URLSearchParams(values).toString()}`;
}

/**
 * Checks that each part appears in the spoken phrases, in this order, each in a later phrase than
 * the one before. With the default capture, each move of the VoiceOver cursor adds one phrase to
 * the log, so the ordered checks run after moves made with the default capture. With
 * `capture: true`, Guidepup joins everything spoken until silence into one entry, and the parts
 * would no longer be in separate phrases.
 */
function expectInOrder(spoken: readonly string[], parts: readonly (string | RegExp)[]): void {
  let from = 0;
  for (const part of parts) {
    const found = spoken.findIndex(
      (phrase, index) =>
        index >= from && (typeof part === "string" ? phrase.includes(part) : part.test(phrase)),
    );
    expect(
      found,
      `"${String(part)}" from phrase ${from} in ${JSON.stringify(spoken)}`,
    ).toBeGreaterThanOrEqual(0);
    from = found + 1;
  }
}

const TITLE = /this link can't be saved - haystack/i;

/**
 * Leaves the web content and enters it again, which is how a user hears the page title, and
 * checks the title. VoiceOver names the web content after the page title, and says that name on
 * leaving and on entering ("Out of <title> web content", "In <title> web content"). The check
 * reads the name of the item VoiceOver is on after leaving, which Guidepup reads from VoiceOver's
 * cursor right after the command, rather than the spoken phrases. Guidepup records speech by
 * polling VoiceOver's last phrase, and on entering, the hint about the banner follows the title
 * at once: in some CI runs, Guidepup recorded only the hint (#151).
 *
 * Both commands capture until VoiceOver stops speaking, so the next command doesn't interrupt the
 * announcement or its hint.
 */
async function leaveAndEnterWebContent(
  voiceOver: VoiceOverPlaywright,
  title: RegExp,
): Promise<void> {
  await voiceOver.stopInteracting({ capture: true });
  expect(await voiceOver.itemText()).toMatch(title);
  await voiceOver.interact({ capture: true });
}

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("an invalid save link announces its title, then the heading and the reasons", async ({
  page,
  voiceOver,
}) => {
  await page.goto(INVALID_LINK);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await voiceOver.navigateToWebContent();

  await leaveAndEnterWebContent(voiceOver, TITLE);

  // Re-entering does not say where the cursor is, so start again from the first item of the page
  // before moving by heading.
  await voiceOver.navigateToWebContent();
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.nextHeading();
  await voiceOver.next();
  await voiceOver.next();
  await voiceOver.next();
  expectInOrder(await voiceOver.spokenPhraseLog(), [
    /\bheading\b.*\blevel 1\b.*this link can't be saved/i,
    /values haystack can't use/i,
    /\blist\b/i,
    /the page title/i,
  ]);
});

test("a save link with a secret announces its title, then the heading and the reason", async ({
  page,
  voiceOver,
}) => {
  await openRefusalPage(page);
  await voiceOver.navigateToWebContent();

  await leaveAndEnterWebContent(voiceOver, TITLE);

  // Re-entering does not say where the cursor is, so start again from the first item of the page
  // before moving by heading.
  await voiceOver.navigateToWebContent();
  await voiceOver.clearSpokenPhraseLog();
  // Read to the end of the page: the heading, the reason, the notice, then the end.
  await voiceOver.nextHeading();
  await voiceOver.next();
  await voiceOver.next();
  await voiceOver.next();
  const spoken = await voiceOver.spokenPhraseLog();
  expectInOrder(spoken, [
    /\bheading\b.*\blevel 1\b.*this link can't be saved/i,
    /access token, key, or password/i,
    /do not save links that contain access tokens/i,
    // Reaching the end of the page means the check below covers all of it.
    /\bend of main\b/i,
  ]);
  // The refusal never repeats the link, which may be the secret.
  expect(spoken.join(" ")).not.toContain("secret-value");
});

test("a rejected title announces the page, then the error, then the field as invalid", async ({
  page,
  voiceOver,
}) => {
  await page.goto(saveUrl({ url: "https://example.com/voiceover-rejected", og_title: "A page" }));
  // Only spaces pass the browser's `required` check and fail on the server, after trimming.
  await page.getByLabel("Title").fill("   ");
  await voiceOver.navigateToWebContent();

  // The user presses Save with VoiceOver, so the page that loads is a result of their action.
  await page.getByRole("button", { name: "Save" }).focus();
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.act({ capture: true });
  // Both the form and the page after it have the heading "Save a link", so wait for the title.
  await expect(page).toHaveTitle("Check the form - Haystack");
  expectInOrder(await voiceOver.spokenPhraseLog(), [/check the form/i]);

  // The page that loaded has no cursor position the test knows, so start from the first item of
  // the page before moving by heading.
  await voiceOver.navigateToWebContent();
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.nextHeading();
  await voiceOver.next();
  expectInOrder(await voiceOver.spokenPhraseLog(), [
    /\bheading\b.*\blevel 1\b.*save a link/i,
    /enter a title of up to 200 characters/i,
  ]);

  // The field gets keyboard focus, and the VoiceOver cursor is moved to it, as for the Save
  // button above. Two ways of moving there through VoiceOver were unreliable on the CI runner,
  // for reasons not yet known, and #83 records the runs: "find the next control" (VO-Command-J)
  // sometimes answered "Form element not found" from the error, and a Tab pressed through
  // VoiceOver here left focus on the body.
  await page.getByLabel("Title").focus();
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus, { capture: true });
  const field = await voiceOver.lastSpokenPhrase();
  expect(field).toMatch(/\btitle\b/i);
  expect(field).toMatch(/\brequired\b/i);
  expect(field).toMatch(/\binvalid data\b/i);
  // The error is the field's description, so the user hears it without moving away from the field.
  expect(field).toMatch(/enter a title of up to 200 characters/i);
  expect(field).toMatch(/\bedit text\b/i);
});

// Without JavaScript, a rejected address gets the server's error page, which this test reads.
// With JavaScript, address-form.js shows the error in place and moves focus to the field, which
// address-form.voiceover.ts reads, so the two tests cover the two paths.
test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("a rejected address announces the error page, then the error, then the field as invalid", async ({
    page,
    voiceOver,
  }) => {
    await page.goto("/save");
    // The browser's own checks are off, so an http: address reaches the server's.
    await page.getByLabel("Save a link").fill("http://example.com/voiceoveraddress");
    await voiceOver.navigateToWebContent();

    // The user presses Continue with VoiceOver, so the page that loads is a result of their action.
    await page.getByRole("button", { name: "Continue" }).focus();
    await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
    await voiceOver.clearSpokenPhraseLog();
    await voiceOver.act({ capture: true });
    await expect(page).toHaveTitle("Check the address - Haystack");
    // The page starts with its header, so VoiceOver can end this announcement with a hint about the
    // banner. The title is part of the same announcement, so the whole log is searched.
    expect((await voiceOver.spokenPhraseLog()).join(" ")).toMatch(/check the address/i);

    // The page that loaded has no cursor position the test knows, so start from the first item of
    // the page before moving by heading. The heading holds the field's label, so VoiceOver may read
    // the label as an item of its own before the error, and the error is looked for in the next two
    // items.
    await voiceOver.navigateToWebContent();
    await voiceOver.clearSpokenPhraseLog();
    await voiceOver.nextHeading();
    await voiceOver.next();
    await voiceOver.next();
    expectInOrder(await voiceOver.spokenPhraseLog(), [
      /\bheading\b.*\blevel 1\b.*save a link|save a link.*\bheading\b.*\blevel 1\b/i,
      /haystack saves only secure pages/i,
    ]);

    // The field gets keyboard focus, and the VoiceOver cursor is moved to it, as in the test of the
    // rejected title above, which says why.
    await page.getByLabel("Save a link").focus();
    await voiceOver.clearSpokenPhraseLog();
    await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus, {
      capture: true,
    });
    const field = (await voiceOver.spokenPhraseLog()).join(" ");
    expect(field).toMatch(/\bsave a link\b/i);
    expect(field).toMatch(/\binvalid data\b/i);
    // The error is the field's description, so the user hears it without moving away from the field.
    expect(field).toMatch(/haystack saves only secure pages/i);
    // The typed address was kept, so the user can correct it. The matched part has no punctuation,
    // because how VoiceOver reads punctuation in an address depends on its verbosity setting.
    expect(field).toMatch(/voiceoveraddress/i);
  });
});
