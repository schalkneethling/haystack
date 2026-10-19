// What VoiceOver says when the delete dialog opens and closes. Each check matches one part of a
// phrase (the role, the title, the order), ignoring case, instead of the whole phrase, so a
// change in how VoiceOver joins them does not fail the test. A change in how it names a role
// does, and is worth reviewing.
import type { VoiceOverPlaywright } from "@guidepup/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./voiceover-fixtures.ts";
import { saveThroughForm } from "./save-through-form.ts";
import { waitForSpoken } from "./wait-for-spoken.ts";

const TITLE = "Vitest guide";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

/** Checks that each phrase is spoken, in this order, ignoring case. */
function expectInOrder(spoken: string, phrases: string[]): void {
  const lower = spoken.toLowerCase();
  let from = 0;
  for (const phrase of phrases) {
    const at = lower.indexOf(phrase.toLowerCase(), from);
    expect(at, `"${phrase}" after position ${from} in: ${spoken}`).toBeGreaterThanOrEqual(0);
    from = at + phrase.length;
  }
}

/** Puts keyboard focus on the item's Delete button, with VoiceOver in the page, ready to press. */
async function focusDeleteButton(
  page: Page,
  voiceOver: VoiceOverPlaywright,
  url: string,
): Promise<void> {
  await saveThroughForm(page, url, TITLE);
  await page.goto("/");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await voiceOver.navigateToWebContent();
  await page.getByRole("button", { name: `Delete ${TITLE}` }).focus();
}

async function openDialog(
  page: Page,
  voiceOver: VoiceOverPlaywright,
  url = "https://example.com/voiceover-delete",
): Promise<string> {
  await focusDeleteButton(page, voiceOver, url);
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.press("Enter", { capture: true });
  await expect(page.getByRole("dialog")).toBeVisible();
  return (await voiceOver.spokenPhraseLog()).join(" ");
}

test("opening the dialog reads its name and which link it deletes, before any button", async ({
  page,
  voiceOver,
}) => {
  const spoken = await openDialog(page, voiceOver);

  // The title is in the dialog's name because VoiceOver does not read a focused dialog's
  // description (plan, "Deleting bookmarks").
  expectInOrder(spoken, ["Delete this link?", TITLE, "dialog"]);
  expect(spoken).not.toMatch(/\bcancel\b/i);
});

test("the first Tab reaches the Cancel button", async ({ page, voiceOver }) => {
  await openDialog(page, voiceOver);
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.press("Tab", { capture: true });

  // The spoken log can miss a short phrase such as "Cancel button" that VoiceOver follows with
  // a hint, but the item under the VoiceOver cursor is reliable.
  expect(await voiceOver.itemText()).toMatch(/\bcancel\b.*\bbutton\b/i);
  expect((await voiceOver.spokenPhraseLog()).join(" ")).toMatch(/\bbutton\b/i);
  await expect(page.getByRole("dialog").getByRole("button", { name: "Cancel" })).toBeFocused();
});

test("Escape closes the dialog, and VoiceOver reads the Delete button that opened it", async ({
  page,
  voiceOver,
}) => {
  await openDialog(page, voiceOver);
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.press("Escape", { capture: true });
  await expect(page.getByRole("dialog")).toBeHidden();

  // As with the first Tab, the spoken log can keep only the hint that follows "Delete … button"
  // (it did in run 38955230463), but the item under the VoiceOver cursor is reliable.
  expectInOrder(await voiceOver.itemText(), ["Delete", TITLE, "button"]);
  expect((await voiceOver.spokenPhraseLog()).join(" ")).toMatch(/\bbutton\b/i);
  await expect(page.getByRole("button", { name: `Delete ${TITLE}` })).toBeFocused();
});

test("confirming reads the status message with the deleted link's title", async ({
  page,
  query,
  voiceOver,
}) => {
  // Its own address, because the Worker and its database are shared by the tests of a process.
  // The other tests sign in as their own users, so their bookmarks are not on this list, but the
  // query at the end would find a row they saved at the default address.
  const url = "https://example.com/voiceover-delete-confirm";
  await openDialog(page, voiceOver, url);
  // Cancel comes first, then Delete.
  await voiceOver.press("Tab");
  await voiceOver.press("Tab");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Delete" })).toBeFocused();
  await voiceOver.clearSpokenPhraseLog();
  await voiceOver.press("Enter", { capture: false });

  await waitForSpoken(voiceOver, new RegExp(`\\bdeleted\\b.*${TITLE}`, "i"));
  await expect(page.getByRole("button", { name: `Delete ${TITLE}` })).toHaveCount(0);
  expect(await query("SELECT id FROM bookmarks WHERE url = ?", url)).toHaveLength(0);
});
