// What VoiceOver says when a link is deleted from the search results (#208): the delete dialog
// of delete-dialog.voiceover.ts, opened from a result's Delete button. The search is answered in
// the browser (search-answers.ts) with a link the test saved, so the delete is the Worker's own.
// Each check matches one part of a phrase, ignoring case, as in delete-dialog.voiceover.ts.
//
// It was written without a local run, because the VoiceOver tests change macOS settings. The
// search is made before VoiceOver moves into the page, so the count, which VoiceOver doesn't
// speak yet (#237), plays no part. The search finds one link, as the saved links page's test
// saves one, so after the delete, focus moves to the page heading, "Search your saved links",
// and the message is written 500 ms later, as on the saved links page (plan, "Deleting
// bookmarks"). That is not #237's case, where focus stays in the search field. One thing differs
// from the saved links page: the live region already holds the count when "Deleted …" replaces
// it, where the saved links page's region is empty, so this test is the check that VoiceOver
// speaks the replacement.
//
// The last test repeats the confirm with the voice input's live region in the page (#216). A
// second, empty `role="status"` region silenced "Deleted …" on the saved links page when it was
// written 100 ms after focus moved (#275, 1.3). The voice input adds its region on the button's
// first press, and Playwright's WebKit has no speech recognition, so the stub adds one and the
// test presses the button once. That test was written without a local run too. On CI, VoiceOver
// spoke "Deleted …" at its first try in each of runs 42122353135, 42126761913, 42256328190 and
// 42256327354, so on this page, at the dialog's 500 ms, the voice region doesn't silence it.
import type { VoiceOverPlaywright } from "@guidepup/playwright";
import type { Page } from "@playwright/test";
import type { HaystackWorker } from "./fixtures.ts";
import { answerSearches, SEARCH_MESSAGES, SEARCH_STATUS, saveResults } from "./search-answers.ts";
import {
  endListening,
  recognitionCount,
  startListening,
  stubSpeechRecognition,
  VOICE_NAME,
  VOICE_STATUS,
} from "./speech-recognition.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const TITLE = "Vitest guide";

type Query = HaystackWorker["query"];

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

/**
 * Presses the voice button once, with recognition stubbed, and lets that recognition start and
 * end, so the voice input's live region is in the page, empty (#216). The stub must be installed
 * before the page loads.
 */
async function addTheVoiceRegion(page: Page): Promise<void> {
  await page.getByRole("button", { name: VOICE_NAME }).click();
  await expect.poll(() => recognitionCount(page)).toBe(1);
  await startListening(page);
  await endListening(page);
  await expect(page.locator(VOICE_STATUS)).toHaveCount(1);
  await expect(page.locator(VOICE_STATUS)).toBeEmpty();
}

/**
 * Saves a link at an address that starts with `prefix`, searches for it, and puts keyboard focus
 * on its result's Delete button, with VoiceOver in the page. With `withVoiceRegion`, the voice
 * input's live region is added first. Returns the bookmark's ID.
 */
async function focusDeleteButton(
  page: Page,
  voiceOver: VoiceOverPlaywright,
  query: Query,
  prefix: string,
  withVoiceRegion = false,
): Promise<string> {
  const saved = await saveResults(page, query, prefix, [TITLE]);
  await answerSearches(page, () => saved);
  if (withVoiceRegion) {
    await stubSpeechRecognition(page);
  }
  await page.goto("/");
  if (withVoiceRegion) {
    await addTheVoiceRegion(page);
  }
  const field = page.getByRole("searchbox", { name: "Search your saved links" });
  await field.fill("a testing guide");
  await field.press("Enter");
  await expect(page.locator(SEARCH_STATUS)).toHaveText(SEARCH_MESSAGES.one);
  await voiceOver.navigateToWebContent();
  await page.getByRole("button", { name: `Delete ${TITLE}` }).focus();
  return String(saved[0]?.id);
}

async function openDialog(
  page: Page,
  voiceOver: VoiceOverPlaywright,
  query: Query,
  prefix: string,
  withVoiceRegion = false,
): Promise<{ id: string; spoken: string }> {
  const id = await focusDeleteButton(page, voiceOver, query, prefix, withVoiceRegion);
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.press("Enter", { capture: true });
  await expect(page.getByRole("dialog")).toBeVisible();
  return { id, spoken: (await voiceOver.spokenPhraseLog()).join(" ") };
}

test("opening the dialog from a result reads its name and which link it deletes, before any button", async ({
  page,
  query,
  voiceOver,
}) => {
  const { spoken } = await openDialog(page, voiceOver, query, "voiceover-search-open");

  // The title is in the dialog's name because VoiceOver does not read a focused dialog's
  // description (plan, "Deleting bookmarks").
  expect(spoken).toMatch(new RegExp(`delete this link\\?.*${TITLE}.*\\bdialog\\b`, "i"));
  expect(spoken).not.toMatch(/\bcancel\b/i);
});

test("Escape closes the dialog, and VoiceOver reads the result's Delete button", async ({
  page,
  query,
  voiceOver,
}) => {
  await openDialog(page, voiceOver, query, "voiceover-search-escape");
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.press("Escape", { capture: true });
  await expect(page.getByRole("dialog")).toBeHidden();

  // The spoken log can keep only the hint that follows "Delete … button", but the item under the
  // VoiceOver cursor is reliable (delete-dialog.voiceover.ts).
  expect(await voiceOver.itemText()).toMatch(
    new RegExp(`\\bdelete\\b.*${TITLE}.*\\bbutton\\b`, "i"),
  );
  expect((await voiceOver.spokenPhraseLog()).join(" ")).toMatch(/\bbutton\b/i);
  await expect(page.getByRole("button", { name: `Delete ${TITLE}` })).toBeFocused();
});

/** Confirms the open dialog with VoiceOver, and checks that "Deleted …" is spoken. */
async function confirmAndHearDeleted(
  page: Page,
  voiceOver: VoiceOverPlaywright,
  query: Query,
  id: string,
): Promise<void> {
  // Cancel comes first, then Delete.
  await voiceOver.press("Tab");
  await voiceOver.press("Tab");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Delete" })).toBeFocused();
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.press("Enter", { capture: false });

  await waitForSpoken(voiceOver, new RegExp(`\\bdeleted\\b.*${TITLE}`, "i"));
  await expect(
    page.getByRole("heading", { level: 1, name: "Search your saved links" }),
  ).toBeFocused();
  await expect(page.getByRole("button", { name: `Delete ${TITLE}` })).toHaveCount(0);
  expect(await query("SELECT id FROM bookmarks WHERE id = ?", id)).toHaveLength(0);
}

test("confirming reads the status message with the deleted link's title", async ({
  page,
  query,
  voiceOver,
}) => {
  const { id } = await openDialog(page, voiceOver, query, "voiceover-search-confirm");
  await confirmAndHearDeleted(page, voiceOver, query, id);
});

test("confirming reads the status message with the voice input's live region in the page", async ({
  page,
  query,
  voiceOver,
}) => {
  const { id } = await openDialog(page, voiceOver, query, "voiceover-search-confirm-voice", true);
  await confirmAndHearDeleted(page, voiceOver, query, id);
});
