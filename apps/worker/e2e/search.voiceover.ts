// What VoiceOver says on the search page (#206, #207): the field's label, each result's title
// when moving by heading, and the live region's messages: the count after a search, the
// processing message while a search runs, the notice that results may be incomplete, and the
// error state. The answers are stubbed in the browser (search-answers.ts), as in the browser
// tests. Each check matches one part of a phrase, ignoring case, as in recent-saves.voiceover.ts.
//
// VoiceOver doesn't speak the live region's messages yet, which #237 is to fix. The page writes
// them to its polite status region while focus stays in the field. The count, written 100 ms
// after the results, was never spoken on CI (run 40849016780), and written 500 ms after them,
// the delete dialog's delay, it wasn't either (run 40854364804): in every try VoiceOver said only
// "browser" and the text field's hint. The processing message, the incomplete notice and the
// error state are written the same way, to the same region, so each is expected to fail for the
// same reason. So each message has a test of its own, marked as failing with `test.fail`, which
// Playwright passes while the test fails, and reports as a failure once it passes, so the mark
// can't outlive the fix. Playwright marks a whole test, not one step, which is why each message
// has a test of its own, and why none of them is a step of the first test. A failing test passes
// `test.fail` whatever makes it fail, so the first test, which takes the same steps up to the
// count and must pass, shows that they still work.
//
// It was written without a local run, because the VoiceOver tests change macOS settings. It
// assumes that Playwright's Enter in the focused field submits the form, as a person's does, and
// that VoiceOver's next heading from the field is the first result's, because the page heading
// comes before the field.
import type { VoiceOverPlaywright } from "@guidepup/playwright";
import type { Locator, Page } from "@playwright/test";
import { installPausedClock } from "./held-lookups.ts";
import {
  answerSearches,
  holdSearches,
  SEARCH_MESSAGES,
  SEARCH_STATUS,
  type StubbedAnswer,
} from "./search-answers.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const LABEL = /search your saved links/i;
const COUNT = /2 saved links match your search/i;
const PROCESSING = /searching your saved links/i;
const INCOMPLETE = /some of your links could not be searched/i;
const FAILED = /something went wrong, so your links could not be searched/i;
const TITLES = ["Vitest browser mode guide", "Playwright locators"] as const;
const FOUND = [
  { title: TITLES[0], description: "Run tests in a real browser." },
  { title: TITLES[1], description: null },
] as const;

/** Why the tests of the live region's messages are marked as failing. */
const NOT_SPOKEN_YET = {
  annotation: {
    type: "issue",
    description:
      "#237: VoiceOver doesn't speak the live region's messages yet (runs 40849016780 and 40854364804)",
  },
};

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

/**
 * Opens the search page with VoiceOver on, checks that the field is read with its label, and
 * presses Enter in the field with a query. Leaves VoiceOver's log cleared just before Enter, so
 * it holds only what was said after it. The test answers /api/search before it calls this.
 */
async function searchFromTheField(page: Page, voiceOver: VoiceOverPlaywright): Promise<Locator> {
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
  return field;
}

/** Searches from the field with an answer of `answer`, and waits for the region's `message`. */
async function searchWith(
  page: Page,
  voiceOver: VoiceOverPlaywright,
  answer: StubbedAnswer,
  message: string,
): Promise<void> {
  await answerSearches(page, () => answer);
  const field = await searchFromTheField(page, voiceOver);
  await expect(page.locator(SEARCH_STATUS)).toContainText(message);
  await expect(field).toBeFocused();
}

/**
 * Checks that VoiceOver said something matching `pattern` after Enter. It can be in what was
 * already captured, so the whole log is searched first, then later phrases.
 */
async function expectSpoken(voiceOver: VoiceOverPlaywright, pattern: RegExp): Promise<void> {
  if (!pattern.test((await voiceOver.spokenPhraseLog()).join(" "))) {
    await waitForSpoken(voiceOver, pattern);
  }
}

test("the field reads its label, and moving by heading after a search reads each result's title", async ({
  page,
  voiceOver,
}) => {
  await searchWith(page, voiceOver, FOUND, "2 saved links match your search.");
  await expect(page.locator("#search-results > li")).toHaveCount(2);

  for (const title of TITLES) {
    await voiceOver.nextHeading();
    const heading = await voiceOver.lastSpokenPhrase();
    expect(heading).toMatch(/\bheading\b/i);
    expect(heading).toMatch(/\blevel 2\b/i);
    expect(heading).toMatch(/\blink\b/i);
    expect(heading).toContain(title);
  }
});

test.fail("the count is spoken after a search", NOT_SPOKEN_YET, async ({ page, voiceOver }) => {
  await searchWith(page, voiceOver, FOUND, "2 saved links match your search.");
  await expectSpoken(voiceOver, COUNT);
});

// The page's clock is Playwright's, paused (installPausedClock), and the test moves it on by the
// script's delay itself, so the held search never reaches the script's 30-second limit while
// VoiceOver speaks.
test.fail(
  "the processing message is spoken while a search runs",
  NOT_SPOKEN_YET,
  async ({ page, voiceOver }) => {
    await installPausedClock(page);
    const searches = await holdSearches(page);
    const field = await searchFromTheField(page, voiceOver);
    await searches.next(1);
    await page.clock.runFor(500);
    await expect(page.locator(SEARCH_STATUS)).toHaveText(SEARCH_MESSAGES.processing);
    await expect(field).toBeFocused();
    await expectSpoken(voiceOver, PROCESSING);
  },
);

test.fail(
  "the notice that results may be incomplete is spoken with the count",
  NOT_SPOKEN_YET,
  async ({ page, voiceOver }) => {
    await searchWith(
      page,
      voiceOver,
      { results: FOUND, outcome: "partial" },
      SEARCH_MESSAGES.incomplete,
    );
    await expectSpoken(voiceOver, INCOMPLETE);
  },
);

test.fail(
  "the error state is spoken after a failed search",
  NOT_SPOKEN_YET,
  async ({ page, voiceOver }) => {
    await searchWith(page, voiceOver, { status: 503 }, SEARCH_MESSAGES.failed);
    await expectSpoken(voiceOver, FAILED);
  },
);
