// What VoiceOver says on the search page (#206): the field's label, the count after a search,
// and each result's title when moving by heading. The answers are stubbed in the browser
// (search-answers.ts), as in the browser tests. Each check matches one part of a phrase, ignoring
// case, as in recent-saves.voiceover.ts.
//
// VoiceOver doesn't speak the count yet, which #237 is to fix. The count is written to the page's
// polite status region while focus stays in the field. Written 100 ms after the results, it was
// never spoken on CI (run 40849016780), and written 500 ms after them, the delete dialog's delay,
// it wasn't either (run 40854364804): in every try VoiceOver said only "browser" and the text
// field's hint. So the count has a test of its own, marked as failing with `test.fail`, which
// Playwright passes while the test fails, and reports as a failure once it passes, so the mark
// can't outlive the fix. Playwright marks a whole test, not one step, which is why the count isn't
// a step of the other test. A failing test passes `test.fail` whatever makes it fail, so the
// other test, which takes the same steps up to the count and must pass, shows that they still
// work.
//
// It was written without a local run, because the VoiceOver tests change macOS settings. It
// assumes that Playwright's Enter in the focused field submits the form, as a person's does, and
// that VoiceOver's next heading from the field is the first result's, because the page heading
// comes before the field.
import type { VoiceOverPlaywright } from "@guidepup/playwright";
import type { Locator, Page } from "@playwright/test";
import { answerSearches } from "./search-answers.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const LABEL = /search your saved links/i;
const COUNT = /2 saved links match your search/i;
const TITLES = ["Vitest browser mode guide", "Playwright locators"] as const;

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

/**
 * Opens the search page with VoiceOver on, checks that the field is read with its label, and
 * searches from the field with Enter, which finds the two results. Leaves VoiceOver's log
 * cleared just before Enter, so it holds only what was said after it.
 */
async function searchFromTheField(page: Page, voiceOver: VoiceOverPlaywright): Promise<Locator> {
  await answerSearches(page, () => [
    { title: TITLES[0], description: "Run tests in a real browser." },
    { title: TITLES[1], description: null },
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
  return field;
}

test("the field reads its label, and moving by heading after a search reads each result's title", async ({
  page,
  voiceOver,
}) => {
  await searchFromTheField(page, voiceOver);

  for (const title of TITLES) {
    await voiceOver.nextHeading();
    const heading = await voiceOver.lastSpokenPhrase();
    expect(heading).toMatch(/\bheading\b/i);
    expect(heading).toMatch(/\blevel 2\b/i);
    expect(heading).toMatch(/\blink\b/i);
    expect(heading).toContain(title);
  }
});

test.fail(
  "the count is spoken after a search",
  {
    annotation: {
      type: "issue",
      description:
        "#237: VoiceOver doesn't speak the result count yet (runs 40849016780 and 40854364804)",
    },
  },
  async ({ page, voiceOver }) => {
    await searchFromTheField(page, voiceOver);
    // The count can be in what was already captured, so the whole log is searched first, then
    // later phrases.
    if (!COUNT.test((await voiceOver.spokenPhraseLog()).join(" "))) {
      await waitForSpoken(voiceOver, COUNT);
    }
  },
);
