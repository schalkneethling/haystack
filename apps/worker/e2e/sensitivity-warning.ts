// The save form's warning that a link might be private (#132), for the browser, design and
// VoiceOver tests. Jev's answers come from the `jev` fixture (fixtures.ts). Each test's links
// need addresses of their own, because the Worker's database is shared by the tests of a process.
import { expect, type Page } from "@playwright/test";
import type { JevAnswers } from "./fixtures.ts";

export const WARNING = "This link looks as if it might be private.";
export const NOT_PRIVATE = "This link does not give access to anything private";
export const UNTICKED_ERROR = `Tick “${NOT_PRIVATE}” to save this link.`;

/** Nouls above and below SENSITIVE_WARN_THRESHOLD in wrangler.jsonc, which is 0.5. */
export const ABOVE_THRESHOLD = 0.9;
export const BELOW_THRESHOLD = 0.1;

export function saveLink(url: string): string {
  return `/save?${new URLSearchParams({ url, og_title: "A shared document" }).toString()}`;
}

/** Opens the save form for `url`, with Jev's answer above the threshold, so it warns. */
export async function openWarnedForm(page: Page, jev: JevAnswers, url: string): Promise<void> {
  jev.noul(ABOVE_THRESHOLD);
  await page.goto(saveLink(url));
  await expect(page.getByText(WARNING)).toBeVisible();
}

/**
 * Sends the save form for `url` without the box, and waits for the form to come back rejected.
 * A form that shows the box is stopped by the browser's own `required` check, so the server's
 * rejection is reached the way a browser reaches it: the form's own check got an answer below
 * the threshold, so it showed no box, and the check on Save warns, as it would when Jev's answer
 * changed, or when the form's check timed out.
 */
export async function sendWithoutTheBox(page: Page, jev: JevAnswers, url: string): Promise<void> {
  jev.noul(BELOW_THRESHOLD, ABOVE_THRESHOLD);
  await page.goto(saveLink(url));
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveTitle("Check the form - Haystack");
  // The title comes before the stylesheets in the page's head, so it can match while they are
  // still loading (#159).
  await page.waitForLoadState("load");
}
