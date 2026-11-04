// TEMPORARY exploration for #237, not to be merged: measures what VoiceOver says when the search
// page's live region changes while focus stays in the field, for each approach the issue lists.
// Each variant changes the page as served, by rewriting the HTML of `/` or `search.js` with
// `page.route`, so the page's own code is unchanged. Every try logs what VoiceOver said.
import type { VoiceOverPlaywright } from "@guidepup/playwright";
import type { Page } from "@playwright/test";
import { answerSearches, SEARCH_STATUS } from "./search-answers.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const COUNT = /2 saved links match your search/i;
const FOUND = [
  { title: "Vitest browser mode guide", description: "Run tests in a real browser." },
  { title: "Playwright locators", description: null },
] as const;
const TRIES = 3;

const REGION_OPEN = '<div id="list-status" class="status" role="status">';
const WRITE = "status.replaceChildren(message);";
const CLEAR = "clearTimeout(announcement);\n    status.replaceChildren();";

interface Variant {
  readonly name: string;
  readonly html?: (page: string) => string;
  readonly script?: (script: string) => string;
}

function replaced(text: string, from: string, to: string): string {
  if (!text.includes(from)) {
    throw new Error(`Variant could not find ${JSON.stringify(from)}`);
  }
  return text.replace(from, to);
}

const VARIANTS: readonly Variant[] = [
  {
    // Approach 1: the region holds a paragraph with text from the start, and each message
    // changes that paragraph's text, rather than an empty region gaining a paragraph.
    name: "holds-text",
    html: (page) =>
      replaced(page, `${REGION_OPEN}</div>`, `${REGION_OPEN}<p>No search yet.</p></div>`),
    script: (script) =>
      replaced(
        replaced(script, WRITE, 'status.querySelector("p").textContent = message.textContent;'),
        CLEAR,
        "clearTimeout(announcement);",
      ),
  },
  {
    // Approach 2a: aria-live="polite" on the div, with no role.
    name: "polite-no-role",
    html: (page) =>
      replaced(page, REGION_OPEN, '<div id="list-status" class="status" aria-live="polite">'),
  },
  {
    // Approach 2b: role="status" with aria-atomic="true".
    name: "status-atomic",
    html: (page) =>
      replaced(
        page,
        REGION_OPEN,
        '<div id="list-status" class="status" role="status" aria-atomic="true">',
      ),
  },
  {
    // Approach 2c: aria-live="polite" and aria-atomic="true", with no role.
    name: "polite-atomic-no-role",
    html: (page) =>
      replaced(
        page,
        REGION_OPEN,
        '<div id="list-status" class="status" aria-live="polite" aria-atomic="true">',
      ),
  },
  {
    // Not in the issue's list, measured only: document.ariaNotify() after the region's write.
    name: "aria-notify",
    script: (script) =>
      replaced(
        script,
        WRITE,
        `${WRITE} console.log("ariaNotify: " + typeof document.ariaNotify); document.ariaNotify?.(message.textContent ?? "");`,
      ),
  },
];

async function applyVariant(page: Page, variant: Variant): Promise<void> {
  const { html, script } = variant;
  if (html !== undefined) {
    await page.route(
      (url) => url.pathname === "/",
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: html(await response.text()) });
      },
    );
  }
  if (script !== undefined) {
    await page.route(
      (url) => url.pathname === "/assets/search.js",
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: script(await response.text()) });
      },
    );
  }
}

/**
 * What VoiceOver said after Enter, and whether it said the count. The flag is kept apart from
 * the phrases, because waitForSpoken's error quotes the pattern, which would match it.
 */
async function heardAfterEnter(
  voiceOver: VoiceOverPlaywright,
): Promise<{ heard: string[]; spoken: boolean }> {
  const before = await voiceOver.spokenPhraseLog();
  if (COUNT.test(before.join(" "))) {
    return { heard: before, spoken: true };
  }
  try {
    return { heard: [...before, ...(await waitForSpoken(voiceOver, COUNT))], spoken: true };
  } catch {
    return { heard: before, spoken: false };
  }
}

test.describe.configure({ retries: 0 });

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

for (const variant of VARIANTS) {
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    test(`#237 ${variant.name} try ${attempt}`, async ({ page, voiceOver }) => {
      page.on("console", (message) => console.log(`[${variant.name}] page: ${message.text()}`));
      await applyVariant(page, variant);
      await answerSearches(page, () => FOUND);
      await page.goto("/");
      const field = page.getByRole("searchbox", { name: "Search your saved links" });
      await field.waitFor();
      console.log(
        `[${variant.name}] region: ${await page.locator(SEARCH_STATUS).evaluate((node) => node.outerHTML)}`,
      );
      await voiceOver.navigateToWebContent();
      await field.focus();
      await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
      await field.fill("testing in a browser");
      await voiceOver.clearSpokenPhraseLog();
      await page.keyboard.press("Enter");
      await expect(page.locator(SEARCH_STATUS)).toContainText("2 saved links match your search.");
      await expect(field).toBeFocused();
      const { heard, spoken } = await heardAfterEnter(voiceOver);
      console.log(
        `[${variant.name}] try ${attempt} ${spoken ? "SPOKEN" : "NOT SPOKEN"}: ${JSON.stringify(heard)}`,
      );
      expect(spoken, `VoiceOver said ${JSON.stringify(heard)}`).toBe(true);
    });
  }
}
