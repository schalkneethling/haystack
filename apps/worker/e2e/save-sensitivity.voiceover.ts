// What VoiceOver reads on the save form when Jev's check warns that the link might be private
// (#132): the warning comes after the notice about private links and before the checkbox, so a
// user who reads the form from the top hears the warning before they reach the box. A user who
// moves straight to the box, with Tab for example, skips the warning paragraph, so the box is
// described by the warning, and VoiceOver reads it with the box.
//
// The checks match parts of phrases, ignoring case, in the order the user hears them, as
// save-pages.voiceover.ts does. The test can't run locally, so its first CI run is its first
// check.
import { expectInOrder } from "./expect-in-order.ts";
import { openWarnedForm } from "./sensitivity-warning.ts";
import { expect, test } from "./voiceover-fixtures.ts";

// The items between the heading and the checkbox are the address, the notice and the warning,
// each of which VoiceOver may read as one item or as several, such as the warning's first
// sentence, which is in bold, and the rest. So the test moves on until VoiceOver reads the
// checkbox, up to this many items, which is far more than the form has.
const MOST_ITEMS = 15;

const WARNING = /looks as if it might be private/i;
const LABEL = /does not give access to anything private/i;

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("the warning is read before the checkbox, and with it as its description", async ({
  page,
  jev,
  voiceOver,
}) => {
  await openWarnedForm(page, jev, "https://example.com/voiceover-warning");
  await voiceOver.navigateToWebContent();

  // Start from the first item of the page, then move by heading to the form's heading, and on
  // through the form one item at a time.
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.nextHeading();
  for (
    let item = 0;
    item < MOST_ITEMS && !/\bcheckbox\b/i.test(await voiceOver.lastSpokenPhrase());
    item += 1
  ) {
    await voiceOver.next();
  }
  // The warning must be in an earlier phrase than the checkbox. The checkbox's own phrase can
  // hold the warning too, as its description, which doesn't count.
  expectInOrder(await voiceOver.spokenPhraseLog(), [
    /\bheading\b.*\blevel 1\b.*save a link/i,
    /do not save links that contain access tokens/i,
    WARNING,
    /\bcheckbox\b/i,
  ]);

  // The box gets keyboard focus, as Tab would give it, and the VoiceOver cursor is moved to it,
  // as save-pages.voiceover.ts moves it to a rejected field, capturing until VoiceOver stops, so
  // the description it reads after a pause is in the log.
  await page.getByRole("checkbox").focus();
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus, { capture: true });
  const checkbox = (await voiceOver.spokenPhraseLog()).join(" ");
  expect(checkbox).toMatch(LABEL);
  expect(checkbox).toMatch(/\bcheckbox\b/i);
  expect(checkbox).toMatch(WARNING);
});
