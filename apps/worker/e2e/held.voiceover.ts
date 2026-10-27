// What VoiceOver says after Release and Retry on the review page at /held (#129). Each loads the
// page again, and the result is in the page title and in the status message, which takes focus
// when the page loads (`autofocus`). VoiceOver speaks a page title when a page loads after the
// user's own action (save-pages.voiceover.ts), and reads an element that takes focus, so either
// one announces the result. The check matches the result's words, ignoring case, rather than a
// whole phrase, so a change in how VoiceOver joins them does not fail the test.
//
// It was written without a local run, so its first CI run is its first check. It assumes that
// VoiceOver's Enter on the focused button sends the form, as the delete dialog's test does.
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

/** Puts keyboard focus on the button, and presses it with VoiceOver. */
async function pressWithVoiceOver(
  page: Page,
  voiceOver: VoiceOverPlaywright,
  button: string,
): Promise<void> {
  await page.getByRole("button", { name: button }).focus();
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.press("Enter", { capture: false });
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
  await pressWithVoiceOver(page, voiceOver, `Release ${TITLE}`);

  await waitForSpoken(voiceOver, new RegExp(`\\breleased\\b.*${TITLE}`, "i"));
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
  await pressWithVoiceOver(page, voiceOver, `Retry ${TITLE}`);

  await waitForSpoken(voiceOver, new RegExp(`\\bretrying\\b.*${TITLE}`, "i"));
  await expect(page.getByRole("button", { name: `Retry ${TITLE}` })).toHaveCount(0);
  const records = await query(
    "SELECT f.bookmark_id FROM enrichment_failures f JOIN bookmarks b ON b.id = f.bookmark_id WHERE b.url = ?",
    url,
  );
  expect(records).toEqual([]);
});
