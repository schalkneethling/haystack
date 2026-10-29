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
import type { VoiceOverPlaywright } from "@guidepup/playwright";
import type { Page } from "@playwright/test";
import type { HaystackWorker } from "./fixtures.ts";
import { answerSearches, SEARCH_MESSAGES, SEARCH_STATUS, saveResults } from "./search-answers.ts";
import { expect, test } from "./voiceover-fixtures.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const TITLE = "Vitest guide";

type Query = HaystackWorker["query"];

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

/**
 * Saves a link at an address that starts with `prefix`, searches for it, and puts keyboard focus
 * on its result's Delete button, with VoiceOver in the page. Returns the bookmark's ID.
 */
async function focusDeleteButton(
  page: Page,
  voiceOver: VoiceOverPlaywright,
  query: Query,
  prefix: string,
): Promise<string> {
  const saved = await saveResults(page, query, prefix, [TITLE]);
  await answerSearches(page, () => saved);
  await page.goto("/");
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
): Promise<{ id: string; spoken: string }> {
  const id = await focusDeleteButton(page, voiceOver, query, prefix);
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

test("confirming reads the status message with the deleted link's title", async ({
  page,
  query,
  voiceOver,
}) => {
  const { id } = await openDialog(page, voiceOver, query, "voiceover-search-confirm");
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
});
