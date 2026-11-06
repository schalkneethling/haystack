// What VoiceOver says about the search page's voice button (#216): its name when VoiceOver
// reaches it, that it is listening once the browser listens, and why it stopped after an error.
// Playwright's WebKit has no speech recognition of its own, so the stub in speech-recognition.ts
// adds one, as in the browser tests, and the test decides when it listens and how it ends. No
// microphone is used. Each check matches one part of a phrase, ignoring case, as in
// search.voiceover.ts.
//
// The button is a toggle with `aria-pressed`, and its messages go to a `role="status"` region of
// their own under the field's row. Focus stays on the button throughout. That is a different
// case from #237's, where the page's live region in the message bar changes while focus stays in
// the field (#275, 1.1), but CI shows the same result: VoiceOver speaks neither "Listening" nor
// the no-speech error. In every try of both tests, in runs 42122353135, 42126761913, 42256328190
// and 42256327354 (macOS 26.6.2), it said only the button's hint after the press, "You are
// currently on a toggle button. To select or deselect this checkbox, press Control-Option-Space.
// …", and nothing in the 15 seconds after it. The problem is recorded on #275, and the markup is
// not changed just to make the tests pass. So those two tests are marked as failing with
// `test.fail`, as in search.voiceover.ts, which Playwright passes while the test fails, and
// reports as a failure once it passes, so the mark can't outlive the fix.
//
// A failing test passes `test.fail` whatever makes it fail, so the first test, which takes the
// same steps up to the message and must pass, shows that they still work: VoiceOver reads the
// button's name when Tab reaches it, which CI confirmed, and again once it is pressed. It also
// attaches what VoiceOver reads on the pressed button to the test's output, which no run has
// recorded yet, because in the runs above that step came after the failing check.
//
// The tests were written without a local run, because the VoiceOver tests change macOS
// settings. `voiceOver.act()`, VoiceOver's own press, presses the button that VoiceOver's cursor
// is on, as the address form's test does with Continue: on CI, the stub's recognition was made
// after it.
import type { VoiceOverPlaywright } from "@guidepup/playwright";
import type { Page } from "@playwright/test";
import {
  failWith,
  recognitionCount,
  startListening,
  stubSpeechRecognition,
  VOICE_MESSAGES,
  VOICE_NAME,
  VOICE_STATUS,
} from "./speech-recognition.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const NAME = /search by voice/i;
const LISTENING = /listening/i;
const NO_SPEECH = /no speech was recognized/i;

/** Why the tests of the voice region's messages are marked as failing. */
const NOT_SPOKEN_YET = {
  annotation: {
    type: "issue",
    description:
      "#275: VoiceOver doesn't speak the voice button's own live region while focus stays on the button (runs 42122353135, 42126761913, 42256328190 and 42256327354)",
  },
};

test.beforeEach(async ({ signIn, page }) => {
  await signIn();
  await stubSpeechRecognition(page);
});

/**
 * Checks that VoiceOver said something matching `pattern` since its log was last cleared. It can
 * be in what was already captured, so the whole log is searched first, then later phrases.
 */
async function expectSpoken(voiceOver: VoiceOverPlaywright, pattern: RegExp): Promise<void> {
  if (!pattern.test((await voiceOver.spokenPhraseLog()).join(" "))) {
    await waitForSpoken(voiceOver, pattern);
  }
}

/**
 * Opens the search page with VoiceOver on, moves to the voice button as a keyboard user does,
 * with Tab from the field, and checks that VoiceOver reads its name.
 */
async function reachTheButton(page: Page, voiceOver: VoiceOverPlaywright): Promise<void> {
  await page.goto("/");
  const button = page.getByRole("button", { name: VOICE_NAME });
  await button.waitFor();
  await voiceOver.navigateToWebContent();
  await page.getByRole("searchbox", { name: "Search your saved links" }).focus();
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
  const atButton = `${(await voiceOver.spokenPhraseLog()).join(" ")} ${await voiceOver.itemText()}`;
  expect(atButton).toMatch(NAME);
}

/** Presses the button with VoiceOver, and lets the stubbed browser start listening. */
async function pressToListen(page: Page, voiceOver: VoiceOverPlaywright): Promise<void> {
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.act({ capture: "initial" });
  await expect.poll(() => recognitionCount(page)).toBe(1);
  await startListening(page);
  await expect(page.getByRole("button", { name: VOICE_NAME })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(VOICE_STATUS)).toHaveText(VOICE_MESSAGES.listening);
}

test("the voice button is read with its name, before and while it is pressed", async ({
  page,
  voiceOver,
}) => {
  await reachTheButton(page, voiceOver);
  await pressToListen(page, voiceOver);

  // The pressed state is `aria-pressed`, which turns true on the `start` event, after the
  // press. CI's runs heard only the hint "You are currently on a toggle button" after the press,
  // so the item under VoiceOver's cursor is attached to the test's output for the next run to
  // record, and only the name, which is certain, is checked. What the record shows goes on #275.
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
  const whilePressed = await voiceOver.itemText();
  await test.info().attach("VoiceOver's item text on the pressed button", {
    body: whilePressed,
    contentType: "text/plain",
  });
  expect(whilePressed).toMatch(NAME);
});

test.fail(
  "the voice button is read with its name, and that it is listening is spoken",
  NOT_SPOKEN_YET,
  async ({ page, voiceOver }) => {
    await reachTheButton(page, voiceOver);
    await pressToListen(page, voiceOver);
    await expectSpoken(voiceOver, LISTENING);
  },
);

test.fail("an error that ends listening is spoken", NOT_SPOKEN_YET, async ({ page, voiceOver }) => {
  await reachTheButton(page, voiceOver);
  await pressToListen(page, voiceOver);
  await voiceOver.clearSpokenPhraseLog();
  await failWith(page, "no-speech");
  await expect(page.locator(VOICE_STATUS)).toHaveText(VOICE_MESSAGES.noSpeech);
  await expect(page.getByRole("button", { name: VOICE_NAME })).toBeFocused();
  await expectSpoken(voiceOver, NO_SPEECH);
});
