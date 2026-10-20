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
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Delete Session save" })).toBeVisible();
});

// The check fails at once for a browser with no session, and the browser stays on Haystack's
// signed-out page, so it never leaves for Google.
test("the check fails at once for a browser with no session", async ({ page, signOut }) => {
  await signOut();
  const started = Date.now();
  await expect(expectSignedIn(page)).rejects.toThrow(/signIn gave the browser a session/);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(new URL(page.url()).pathname).toBe("/auth/signed-out");
});
