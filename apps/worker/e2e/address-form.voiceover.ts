// What VoiceOver says while the address form looks a page up (#105), when the address is
// rejected, and when the user is signed out. address-form.js sends the form with `fetch`, and the
// test holds each request (held-lookups.ts), so it can listen before it lets a request through.
//
// The script moves focus to its message, because on CI VoiceOver read a message focused 100 ms
// after the press every time, and missed it every time as a live region or an alert (plan, "The
// address form (#97)"). The runs measured that on Playwright's WebKit on macOS 26, not Safari.
//
// The page's clock is Playwright's, paused (installPausedClock), and the test moves it on by the
// script's 100 ms itself. A held request would otherwise reach the script's 10-second timeout
// while VoiceOver is still speaking: on CI a press with `capture: true` waited longer than that
// (run 39444075815). Presses use Guidepup's `capture: "initial"`, which looks at VoiceOver's
// output once, and `waitForSpoken` listens after that.
//
// It was written without a local run, because the VoiceOver tests change macOS settings, so its
// first CI run is its first check. It assumes four things:
// - VoiceOver's Space on the focused Continue button (`act`) submits the form, as it does in the
//   rejected address test in save-pages.voiceover.ts.
// - VoiceOver follows focus to the message, as it did in the investigation's runs, and reads it.
// - When the script moves focus to the field after a rejection, VoiceOver follows it and reads
//   the field with its description, the error first.
// - The paused clock drives the script's timers in headed WebKit as in the browser tests.
import { holdLookups, installPausedClock, MESSAGES } from "./held-lookups.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const PROCESSING = /looking up the page/i;
const REJECTED = /haystack saves only secure pages/i;
const SIGNED_OUT = /you are signed out/i;

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("the lookup's message is read when it takes focus, a rejected address at the field, and a signed-out message when it takes focus", async ({
  page,
  pages,
  voiceOver,
}) => {
  await installPausedClock(page);
  const lookups = await holdLookups(page);
  const field = page.getByRole("textbox", { name: "Save a link" });
  const message = page.locator("#save-url-status > p");
  await page.goto("/save");
  // No https://, so the server rejects it once the request is let through.
  await field.fill("pages.test/voiceover-rejected");
  await voiceOver.navigateToWebContent();

  // The user presses Continue with VoiceOver, and the script writes and focuses its message
  // 100 ms later.
  await page.getByRole("button", { name: "Continue" }).focus();
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.act({ capture: "initial" });
  const rejected = await lookups.next(1);
  await page.clock.runFor(100);
  await expect(message).toHaveText(MESSAGES.processing);
  await expect(message).toBeFocused();
  // The message can be part of what was captured after the press, so the whole log is searched
  // first, then later phrases.
  if (!PROCESSING.test((await voiceOver.spokenPhraseLog()).join(" "))) {
    await waitForSpoken(voiceOver, PROCESSING);
  }
  expect(await voiceOver.itemText()).toMatch(PROCESSING);

  // The server rejects the address, and the script moves focus to the field, which VoiceOver
  // reads with the error as its description.
  await voiceOver.clearSpokenPhraseLog();
  await rejected.release();
  await expect(field).toBeFocused();
  const spoken = (await voiceOver.spokenPhraseLog()).join(" ");
  const heard = REJECTED.test(spoken) ? [spoken] : await waitForSpoken(voiceOver, REJECTED);
  expect(heard.join(" ")).toMatch(REJECTED);

  // A corrected address, answered as if the session had ended: the signed-out message replaces
  // the processing message and takes its focus.
  await field.fill(pages.url("/voiceover-signed-out"));
  await page.getByRole("button", { name: "Continue" }).focus();
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
  await voiceOver.act({ capture: "initial" });
  const signedOut = await lookups.next(2);
  await page.clock.runFor(100);
  await expect(message).toHaveText(MESSAGES.processing);
  await voiceOver.clearSpokenPhraseLog();
  await signedOut.answer(401);
  // Continue gets its own label back when the script has the answer, and the message follows
  // 100 ms later.
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await page.clock.runFor(100);
  await expect(message).toHaveText(MESSAGES.signedOut);
  await expect(message).toBeFocused();
  if (!SIGNED_OUT.test((await voiceOver.spokenPhraseLog()).join(" "))) {
    await waitForSpoken(voiceOver, SIGNED_OUT);
  }
});
