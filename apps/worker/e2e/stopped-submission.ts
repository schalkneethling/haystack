// Keeps the address form on the page in its pending state (#105, address-form.js), for the tests
// that look at that state: the browser, axe and VoiceOver tests.
//
// A listener on the window, added before the page's scripts run, cancels each submission after
// address-form.js has handled it, because a submit event reaches the form before it bubbles up to
// the window. So the form shows its pending state and stays on the page for as long as the test
// needs, and the listener records whether address-form.js let each submission through or refused
// it. Holding the request with `page.route` would not do: while a navigation is pending,
// Playwright's locators and `page.evaluate` wait for it to finish.
import type { Page } from "@playwright/test";

/** What address-form.js did with a submission: let it through, or refuse it. */
export type Submission = "sent" | "refused";

interface SubmissionLog {
  haystackSubmissions?: Submission[];
}

export async function stopSubmissions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.addEventListener("submit", (event) => {
      const log = window as Window & SubmissionLog;
      log.haystackSubmissions ??= [];
      log.haystackSubmissions.push(event.defaultPrevented ? "refused" : "sent");
      event.preventDefault();
    });
  });
}

/** The submissions since the page loaded, in order. */
export function submissions(page: Page): Promise<Submission[]> {
  return page.evaluate(() => (window as Window & SubmissionLog).haystackSubmissions ?? []);
}

/** The status message that address-form.js writes while the page is looked up. */
export const PENDING_MESSAGE = "Looking up the page. This can take a few seconds.";

/** The status message that address-form.js writes when it makes a stopped form ready again. */
export const RESET_MESSAGE =
  "Looking up the page didn't finish. You can press Continue to try again.";
