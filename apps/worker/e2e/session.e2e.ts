// The sign-in that the browser and VoiceOver tests use (fixtures.ts). It runs in Chromium with
// the other browser tests, and in WebKit, without VoiceOver, before the VoiceOver tests
// (playwright.voiceover.config.ts), because the two browsers carry the session differently and
// a session that WebKit did not send once failed every VoiceOver test (#107). Run it in WebKit
// locally with `vp exec playwright test --config playwright.voiceover.config.ts --project
// webkit-session`, which starts no VoiceOver.
import { expect, expectSignedIn, test } from "./fixtures.ts";
import { saveThroughForm } from "./save-through-form.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

// The address form's lookup ends with a 303 to GET /save, which must still carry the session.
test("the session lasts through the address form's lookup and its redirect", async ({
  page,
  pages,
}) => {
  pages.page("/session", "<head><title>Session check</title></head>");
  await page.goto("/save");
  await page.getByRole("textbox", { name: "Save a link" }).fill(pages.url("/session"));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("Session check");
});

// The path the delete dialog's VoiceOver tests take: a save link, then the confirmation.
test("the session lasts through a save", async ({ page }) => {
  await saveThroughForm(page, "https://example.com/session-save", "Session save");
  await page.goto("/saved-links");
  await expect(page.getByRole("button", { name: "Delete Session save" })).toBeVisible();
});

// The check fails at once for a browser with no session, and the browser stays on Haystack's
// signed-out page, so it never leaves for Google. What the browser asked for shows that it failed
// at once: it loaded the signed-out page and asked for `/` once, so the check neither retried nor
// followed a redirect. A check that waited without asking for anything more would still pass that,
// so the test also bounds the time, at 5 seconds. The check takes about 300 ms, so the bound has
// more than 15 times that in hand for a busy machine, while a wait on one of Playwright's
// assertions, which time out after 5 seconds, would pass it (#141).
test("the check fails at once for a browser with no session", async ({
  page,
  signOut,
  baseURL,
}) => {
  await signOut();
  const started = Date.now();
  const requests: string[] = [];
  page.on("request", (request) => {
    if (["document", "fetch"].includes(request.resourceType())) {
      requests.push(`${request.resourceType()} ${request.url()}`);
    }
  });
  await expect(expectSignedIn(page)).rejects.toThrow(/signIn gave the browser a session/);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(requests).toEqual([
    `document ${new URL("/auth/signed-out", baseURL).href}`,
    `fetch ${new URL("/", baseURL).href}`,
  ]);
  expect(new URL(page.url()).pathname).toBe("/auth/signed-out");
});
