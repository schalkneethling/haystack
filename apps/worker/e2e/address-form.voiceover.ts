// What VoiceOver says while the address form looks a page up (#105), and when the address is
// rejected. address-form.js sends the form with `fetch`, and the test holds that request
// (held-lookups.ts), so it can listen to the processing state before it lets the request through.
//
// It was written without a local run, because the VoiceOver tests change macOS settings, so its
// first CI run is its first check. It assumes four things:
// - VoiceOver speaks a polite status message that is written 100 ms after the user presses
//   Continue, as it speaks the delete dialog's 100 ms after the dialog closes (#56).
// - VoiceOver's Space on the focused Continue button (`act`) submits the form, as it does in the
//   rejected address test in save-pages.voiceover.ts.
// - The VoiceOver cursor stays on the button, whose label is then "Processing…". The button is
//   never disabled, so VoiceOver does not call it dimmed.
// - When the script moves focus to the field after a rejection, VoiceOver follows it and reads
//   the field with its description, the error first.
import { holdLookups, MESSAGES } from "./held-lookups.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const PROCESSING = /looking up the page/i;
const REJECTED = /haystack saves only secure pages/i;

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("pressing Continue announces the lookup, and a rejected address is read at the field", async ({
  page,
  voiceOver,
}) => {
  const lookups = await holdLookups(page);
  await page.goto("/save");
  // No https://, so the server rejects it once the request is let through.
  await page.getByRole("textbox", { name: "Save a link" }).fill("pages.test/voiceover-rejected");
  await voiceOver.navigateToWebContent();

  // The user presses Continue with VoiceOver.
  await page.getByRole("button", { name: "Continue" }).focus();
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.act({ capture: true });
  const lookup = await lookups.next(1);
  await expect(page.locator("#save-url-status")).toHaveText(MESSAGES.processing);

  // The message can be part of the announcement that pressing the button started, so the whole
  // log is searched first, then later phrases.
  if (!PROCESSING.test((await voiceOver.spokenPhraseLog()).join(" "))) {
    await waitForSpoken(voiceOver, PROCESSING);
  }
  // Focus did not move, and the button says what it is doing.
  await expect(page.getByRole("button", { name: "Processing…" })).toBeFocused();
  expect(await voiceOver.itemText()).toMatch(/processing/i);

  // The server rejects the address, and the script moves focus to the field, which VoiceOver
  // reads with the error as its description.
  await voiceOver.clearSpokenPhraseLog();
  await lookup.release();
  await expect(page.getByRole("textbox", { name: "Save a link" })).toBeFocused();
  const spoken = (await voiceOver.spokenPhraseLog()).join(" ");
  const heard = REJECTED.test(spoken) ? [spoken] : await waitForSpoken(voiceOver, REJECTED);
  expect(heard.join(" ")).toMatch(REJECTED);
  expect(await voiceOver.itemText()).toMatch(/save a link/i);
});
