// What VoiceOver says on the search page (#206): the field's label, the count after a search,
// and each result's title when moving by heading. The answers are stubbed in the browser
// (search-answers.ts), as in the browser tests. Each check matches one part of a phrase, ignoring
// case, as in recent-saves.voiceover.ts.
//
// It was written without a local run, because the VoiceOver tests change macOS settings, so its
// first CI run is its first check. It assumes three things:
// - The count, written to the page's polite status region 100 ms after the results, is spoken
//   while focus stays in the field. On CI, VoiceOver missed a polite status message after the
//   address form's Continue was pressed (plan, "The address form (#97)"), but that button's own
//   label changed at the same moment, and nothing about the focused field changes here. If this
//   check fails, that is the finding to record in the plan, and the page needs another way to
//   announce the count.
// - Playwright's Enter in the focused field submits the form, as a person's does, and VoiceOver
//   hears what the page does next whichever way the key arrived.
// - VoiceOver's next heading from the field is the first result's, because the page heading comes
//   before the field.
import { answerSearches } from "./search-answers.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const LABEL = /search your saved links/i;
const COUNT = /2 saved links match your search/i;

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("the field reads its label, the count is spoken after a search, and moving by heading reads each result's title", async ({
  page,
  voiceOver,
}) => {
  await answerSearches(page, () => [
    { title: "Vitest browser mode guide", description: "Run tests in a real browser." },
    { title: "Playwright locators", description: null },
  ]);
  await page.goto("/");
  const field = page.getByRole("searchbox", { name: "Search your saved links" });
  await field.waitFor();
  await voiceOver.navigateToWebContent();

  // The field, reached as a keyboard user reaches it, is read with its label.
  await field.focus();
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
  const atField = `${(await voiceOver.spokenPhraseLog()).join(" ")} ${await voiceOver.itemText()}`;
  expect(atField).toMatch(LABEL);

  await field.fill("testing in a browser");
  await voiceOver.clearSpokenPhraseLog();
  await page.keyboard.press("Enter");
  await expect(page.locator("#search-results > li")).toHaveCount(2);
  await expect(page.locator("#list-status")).toHaveText("2 saved links match your search.");
  await expect(field).toBeFocused();
  // The count can be in what was already captured, so the whole log is searched first, then
  // later phrases.
  if (!COUNT.test((await voiceOver.spokenPhraseLog()).join(" "))) {
    await waitForSpoken(voiceOver, COUNT);
  }

  for (const title of ["Vitest browser mode guide", "Playwright locators"]) {
    await voiceOver.nextHeading();
    const heading = await voiceOver.lastSpokenPhrase();
    expect(heading).toMatch(/\bheading\b/i);
    expect(heading).toMatch(/\blevel 2\b/i);
    expect(heading).toMatch(/\blink\b/i);
    expect(heading).toContain(title);
  }
});
