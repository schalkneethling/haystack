// What VoiceOver says on the save pages that report a problem: the page for an invalid link,
// the refusal page for a link with a secret in it, and the save form after a rejected title.
// Each check matches one part of a phrase, ignoring case, and the parts must come in the order
// the user hears them. A change in how VoiceOver words a role fails the test and is worth
// reviewing.
//
// VoiceOver does not speak a page title when a script loads the page. It speaks it when the user
// enters the web content ("In <title> web content") and when a page loads after the user's own
// action, so the tests do the same. The error paragraph on the form is not a live announcement
// either: it is in the page when it loads, so the user reaches it by moving to it. The field
// reads the error as its description, which works only because the field points at a plain
// paragraph inside the alert, not at the alert itself (see "Save flow" in the plan).
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

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("an invalid save link announces its title, then the heading and the reasons", async ({
  page,
  voiceOver,
}) => {
  await page.goto(saveUrl({ url: "javascript:alert(1)" }));
  await page.getByRole("heading", { level: 1 }).waitFor();
  await voiceOver.navigateToWebContent();

  // Leaving and entering the web content again is how a user hears the page title.
  await voiceOver.stopInteracting({ capture: true });
  await voiceOver.interact({ capture: true });
  expect(await voiceOver.lastSpokenPhrase()).toMatch(/this link can't be saved - haystack/i);

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
    /the address of the page/i,
  ]);
});

test("a save link with a secret announces its title, then the heading and the reason", async ({
  page,
  voiceOver,
}) => {
  await page.goto(saveUrl({ url: "https://example.com/?access_token=secret-value" }));
  await page.getByRole("heading", { level: 1 }).waitFor();
  await voiceOver.navigateToWebContent();

  await voiceOver.stopInteracting({ capture: true });
  await voiceOver.interact({ capture: true });
  expect(await voiceOver.lastSpokenPhrase()).toMatch(/this link can't be saved - haystack/i);

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

  // Tab reaches the field wherever the cursor is, because it is the first control on the page.
  // VoiceOver's "find the next control" (VO-Command-J) sometimes answered "Form element not
  // found" while the cursor was on the error, and the retry in the same CI job failed the same
  // way, so the test no longer uses it (#83).
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.press("Tab", { capture: true });
  await expect(page.getByLabel("Title")).toBeFocused();
  const field = await voiceOver.lastSpokenPhrase();
  expect(field).toMatch(/\btitle\b/i);
  expect(field).toMatch(/\brequired\b/i);
  expect(field).toMatch(/\binvalid data\b/i);
  // The error is the field's description, so the user hears it without moving away from the field.
  expect(field).toMatch(/enter a title of up to 200 characters/i);
  expect(field).toMatch(/\bedit text\b/i);
});
