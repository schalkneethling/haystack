// What VoiceOver says on the search page (#206): the field's label, the count after a search,
// and each result's title when moving by heading. The answers are stubbed in the browser
// (search-answers.ts), as in the browser tests. Each check matches one part of a phrase, ignoring
// case, as in recent-saves.voiceover.ts.
//
// It was written without a local run, because the VoiceOver tests change macOS settings. It
// assumes three things:
// - The count, written to the page's polite status region 500 ms after the results, is spoken
//   while focus stays in the field. Written 100 ms after them, it was never spoken in the first
//   CI run (40849016780), which heard only the field's label, "browser" and the text field's
//   hint, so the delay is now the delete dialog's (plan, "Search page"). If it still isn't
//   spoken, the page needs another way to announce the count.
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
