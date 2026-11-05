// TEMPORARY exploration for #237, not to be merged: measures the heading approach. After a
// search, focus moves to the results' `h2`, made focusable with tabindex -1 as the delete dialog
// does (delete-dialog.js, moveFocus), and the message is written to `#list-status` 500 ms later,
// as the script already does: the delete dialog's order. The script is changed as served, with
// `page.route`, so the page's own code is unchanged. Each try logs everything VoiceOver said
// after Enter, up to the message and for a few seconds after it, so the record shows what a
// person hears after a search, and whether the heading is read before the message.
import type { VoiceOverPlaywright } from "@guidepup/playwright";
import type { Page } from "@playwright/test";
import {
  answerSearches,
  SEARCH_MESSAGES,
  SEARCH_STATUS,
  type StubbedAnswer,
} from "./search-answers.ts";
import { expect, test } from "./voiceover-fixtures.ts";

const FOUND = [
  { title: "Vitest browser mode guide", description: "Run tests in a real browser." },
  { title: "Playwright locators", description: null },
] as const;

const SHOW = "show(results);";
const FOCUS_HEADING = `${SHOW}
      const heading = document.getElementById(RESULTS_HEADING_ID);
      if (heading !== null && !heading.hidden) {
        heading.tabIndex = -1;
        heading.focus();
      }`;

// How long to go on listening after the message, to record anything VoiceOver says after it.
const LISTEN_AFTER_MS = 6_000;

interface Case {
  readonly name: string;
  readonly answer: StubbedAnswer;
  readonly written: string;
  readonly pattern: RegExp;
  readonly tries: number;
}

const CASES: readonly Case[] = [
  {
    name: "count",
    answer: FOUND,
    written: "2 saved links match your search.",
    pattern: /2 saved links match your search/i,
    tries: 4,
  },
  {
    name: "incomplete",
    answer: { results: FOUND, outcome: "partial" },
    written: SEARCH_MESSAGES.incomplete,
    pattern: /some of your links could not be searched/i,
    tries: 3,
  },
];

async function focusHeadingAfterResults(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/assets/search.js",
    async (route) => {
      const response = await route.fetch();
      const script = await response.text();
      if (!script.includes(SHOW)) {
        throw new Error(`search.js has no ${SHOW}`);
      }
      await route.fulfill({ response, body: script.replace(SHOW, FOCUS_HEADING) });
    },
  );
}

// How long to wait for the message, as waitForSpoken waits.
const WAIT_FOR_MESSAGE_MS = 15_000;

/**
 * Every phrase VoiceOver said after Enter, collected here rather than from waitForSpoken, whose
 * error is the only place it keeps its phrases and which quotes the pattern. It looks as
 * waitForSpoken looks, pressing Shift with `capture: "initial"`, until the message is said or
 * WAIT_FOR_MESSAGE_MS passes, and once it is said, for LISTEN_AFTER_MS more. `messageAt` is the
 * index of the first phrase that holds the message, or -1.
 */
async function collect(
  voiceOver: VoiceOverPlaywright,
  pattern: RegExp,
): Promise<{ heard: string[]; messageAt: number }> {
  const heard: string[] = [];
  const add = (phrase: string) => {
    if (phrase !== "" && phrase !== heard.at(-1)) {
      heard.push(phrase);
    }
  };
  for (const phrase of await voiceOver.spokenPhraseLog()) {
    add(phrase);
  }
  let messageAt = heard.findIndex((phrase) => pattern.test(phrase));
  let deadline = Date.now() + (messageAt === -1 ? WAIT_FOR_MESSAGE_MS : LISTEN_AFTER_MS);
  while (Date.now() < deadline) {
    await voiceOver.press("Shift", { capture: "initial" });
    add((await voiceOver.spokenPhraseLog()).at(-1) ?? "");
    if (messageAt === -1) {
      messageAt = heard.findIndex((phrase) => pattern.test(phrase));
      if (messageAt !== -1) {
        deadline = Date.now() + LISTEN_AFTER_MS;
      }
    }
  }
  return { heard, messageAt };
}

test.describe.configure({ retries: 0 });

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

for (const { name, answer, written, pattern, tries } of CASES) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    test(`#237 heading focus, ${name}, try ${attempt}`, async ({ page, voiceOver }) => {
      await focusHeadingAfterResults(page);
      await answerSearches(page, () => answer);
      await page.goto("/");
      const field = page.getByRole("searchbox", { name: "Search your saved links" });
      await field.waitFor();
      await voiceOver.navigateToWebContent();
      await field.focus();
      await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
      await field.fill("testing in a browser");
      await voiceOver.clearSpokenPhraseLog();
      await page.keyboard.press("Enter");
      await expect(page.locator(SEARCH_STATUS)).toContainText(written);
      await expect(page.getByRole("heading", { name: "Results", level: 2 })).toBeFocused();
      const { heard, messageAt } = await collect(voiceOver, pattern);
      const item = await voiceOver.itemText();
      console.log(
        `[${name}] try ${attempt} ${messageAt === -1 ? "NOT SPOKEN" : `SPOKEN at phrase ${messageAt + 1} of ${heard.length}`}: ${JSON.stringify(heard)}`,
      );
      console.log(`[${name}] try ${attempt} VoiceOver's cursor is on: ${JSON.stringify(item)}`);
      expect(messageAt, `VoiceOver said ${JSON.stringify(heard)}`).toBeGreaterThanOrEqual(0);
    });
  }
}
