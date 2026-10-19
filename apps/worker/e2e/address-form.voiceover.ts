// What VoiceOver says while the address form looks a page up (#105). The form stays on the page
// in its pending state, because each submission is stopped after address-form.js has handled it
// (stopped-submission.ts), so the test does not race the Worker's answer.
//
// It was written without a local run, because the VoiceOver tests change macOS settings, so its
// first CI run is its first check. It assumes three things:
// - VoiceOver speaks a polite status message that is written 100 ms after the user presses
//   Continue, as it speaks the delete dialog's 100 ms after the dialog closes (#56).
// - VoiceOver's Space on the focused Continue button (`act`) submits the form, as it does in the
//   rejected address test in save-pages.voiceover.ts.
// - The VoiceOver cursor stays on the button, whose text is then "Looking up…".
import { stopSubmissions } from "./stopped-submission.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const PENDING = /looking up the page/i;

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("pressing Continue announces that the page is being looked up", async ({
  page,
  pages,
  voiceOver,
}) => {
  await stopSubmissions(page);
  await page.goto("/save");
  await page.getByRole("textbox", { name: "Save a link" }).fill(pages.url("/voiceover-pending"));
  await voiceOver.navigateToWebContent();

  // The user presses Continue with VoiceOver.
  await page.getByRole("button", { name: "Continue" }).focus();
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.act({ capture: true });
  await expect(page.locator("#save-url-status")).toHaveText(/looking up the page/i);

  // The message can be part of the announcement that pressing the button started, so the whole
  // log is searched first, then later phrases.
  if (!PENDING.test((await voiceOver.spokenPhraseLog()).join(" "))) {
    await waitForSpoken(voiceOver, PENDING);
  }

  // Focus did not move, and the button says what it is waiting for.
  await expect(page.getByRole("button", { name: "Looking up…" })).toBeFocused();
  expect(await voiceOver.itemText()).toMatch(/looking up/i);
});
