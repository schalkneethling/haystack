// What VoiceOver says after Release and Retry on the review page at /held (#129). Each loads the
// page again, and the result is in the page title and in the status message, which takes focus
// when the page loads (`autofocus`). VoiceOver speaks a page title when a page loads after the
// user's own action (save-pages.voiceover.ts), and reads an element that takes focus, so either
// one announces the result. The check matches the result's words, ignoring case, rather than a
// whole phrase, so a change in how VoiceOver joins them does not fail the test.
//
// Each button sends a form that loads a page, as Save and Continue do in save-pages.voiceover.ts,
// so the test presses it the same way: the VoiceOver cursor is moved to the focused button, and
// VoiceOver's own action presses it, capturing what is spoken until it stops. Once the page that
// loads has its title, the whole log is searched, and if the result isn't in it yet,
// waitForSpoken looks at later phrases, as address-form.voiceover.ts does. It was written without
// a local run, so its first CI run is its first check.
import type { VoiceOverPlaywright } from "@guidepup/playwright";
import type { Page } from "@playwright/test";
import { saveFailed, saveHeld } from "./review-items.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const TITLE = "Vitest guide";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

/** Opens /held, with VoiceOver in the page. */
async function openWithVoiceOver(page: Page, voiceOver: VoiceOverPlaywright): Promise<void> {
  await page.goto("/held");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await voiceOver.navigateToWebContent();
}

/**
 * Presses the button with VoiceOver, so the page that loads is a result of the user's action,
 * then waits for that page's title and for VoiceOver to say `result`.
 */
async function pressWithVoiceOver(
  page: Page,
  voiceOver: VoiceOverPlaywright,
  button: string,
  title: string,
  result: RegExp,
): Promise<void> {
  await page.getByRole("button", { name: button }).focus();
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.act({ capture: true });
  await expect(page).toHaveTitle(title);
  if (!result.test((await voiceOver.spokenPhraseLog()).join(" "))) {
    await waitForSpoken(voiceOver, result);
  }
}

test("releasing a Held link announces that it was released", async ({
  page,
  query,
  run,
  voiceOver,
}) => {
  const url = "https://example.com/voiceover-release";
  await saveHeld(page, run, url, TITLE);
  await openWithVoiceOver(page, voiceOver);
  await page.getByRole("checkbox").check();
  await pressWithVoiceOver(
    page,
    voiceOver,
    `Release ${TITLE}`,
    `Released “${TITLE}” - Links to review - Haystack`,
    new RegExp(`\\breleased\\b.*${TITLE}`, "i"),
  );
  await expect(page.getByRole("button", { name: `Release ${TITLE}` })).toHaveCount(0);
  const [row] = await query(
    "SELECT sensitivity_acknowledged_at AS at FROM bookmarks WHERE url = ?",
    url,
  );
  expect(row?.at).not.toBeNull();
});

test("retrying a Failed link announces that it is being retried", async ({
  page,
  query,
  run,
  voiceOver,
}) => {
  const url = "https://example.com/voiceover-retry";
  await saveFailed(page, run, url, TITLE);
  await openWithVoiceOver(page, voiceOver);
  await pressWithVoiceOver(
    page,
    voiceOver,
    `Retry ${TITLE}`,
    `Retrying “${TITLE}” - Links to review - Haystack`,
    new RegExp(`\\bretrying\\b.*${TITLE}`, "i"),
  );
  await expect(page.getByRole("button", { name: `Retry ${TITLE}` })).toHaveCount(0);
  const records = await query(
    "SELECT f.bookmark_id FROM enrichment_failures f JOIN bookmarks b ON b.id = f.bookmark_id WHERE b.url = ?",
    url,
  );
  expect(records).toEqual([]);
});
