// What VoiceOver says while the address form looks a page up (#105). The form stays on the page
// in its pending state, because each submission is stopped after address-form.js has handled it
// (stopped-submission.ts), so the test does not race the Worker's answer.
//
// It was written without a local run, because the VoiceOver tests change macOS settings, so its
// first CI run is its first check. It assumes four things:
// - VoiceOver speaks a polite status message that is written 100 ms after the user presses
//   Continue, and after the form is made ready again, as it speaks the delete dialog's 100 ms
//   after the dialog closes (#56).
// - VoiceOver's Space on the focused Continue button (`act`) submits the form, as it does in the
//   rejected address test in save-pages.voiceover.ts.
// - The VoiceOver cursor stays on the button, whose text is then "Looking up…".
// - Playwright's clock, installed before the page loads, drives the script's timers in headed
//   WebKit, so the test reaches the 15-second reset without waiting for it.
import { stopSubmissions } from "./stopped-submission.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const PENDING = /looking up the page/i;
const RESET = /didn't finish|did not finish/i;

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("pressing Continue announces the lookup, and then that the form is ready again", async ({
  page,
  pages,
  voiceOver,
}) => {
  await stopSubmissions(page);
  await page.clock.install();
  await page.goto("/save");
  await page.getByRole("textbox", { name: "Save a link" }).fill(pages.url("/voiceover-pending"));
  await voiceOver.navigateToWebContent();

  // The user presses Continue with VoiceOver.
  await page.getByRole("button", { name: "Continue" }).focus();
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.act({ capture: true });
  // The script writes the message 100 ms after the press.
  await page.clock.fastForward(100);
  await expect(page.locator("#save-url-status")).toHaveText(PENDING);

  // The message can be part of the announcement that pressing the button started, so the whole
  // log is searched first, then later phrases.
  if (!PENDING.test((await voiceOver.spokenPhraseLog()).join(" "))) {
    await waitForSpoken(voiceOver, PENDING);
  }

  // Focus did not move, and the button says what it is waiting for.
  await expect(page.getByRole("button", { name: "Looking up…" })).toBeFocused();
  expect(await voiceOver.itemText()).toMatch(/looking up/i);

  // The submission never comes back, so after 15 s the form is ready again, and 100 ms later the
  // script says so in the status region.
  await voiceOver.clearSpokenPhraseLog();
  await page.clock.fastForward(15_000);
  await page.clock.fastForward(100);
  await expect(page.locator("#save-url-status")).toHaveText(RESET);
  if (!RESET.test((await voiceOver.spokenPhraseLog()).join(" "))) {
    await waitForSpoken(voiceOver, RESET);
  }
  await expect(page.getByRole("button", { name: "Continue" })).toBeFocused();
});
