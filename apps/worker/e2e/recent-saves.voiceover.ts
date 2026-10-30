// What VoiceOver says on the recent saves list. Each check matches one part of a phrase (the
// role, the level, the text), ignoring case, instead of the whole phrase, so a change in how
// VoiceOver joins them does not fail the test. A change in how it names a role does, and is
// worth reviewing.
import { expect, test } from "./voiceover-fixtures.ts";
import { saveThroughForm } from "./save-through-form.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("moving by heading reads the page heading, the address form's heading, then each saved link's title", async ({
  page,
  voiceOver,
}) => {
  await saveThroughForm(page, "https://example.com/voiceover-older", "Older guide");
  await saveThroughForm(page, "https://example.com/voiceover-newer", "Newer guide");
  await page.goto("/saved-links");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await voiceOver.navigateToWebContent();

  await voiceOver.nextHeading();
  const pageHeading = await voiceOver.lastSpokenPhrase();
  expect(pageHeading).toMatch(/\bheading\b/i);
  expect(pageHeading).toMatch(/\blevel 1\b/i);
  expect(pageHeading).toContain("Saved links");

  // The address form's heading, under the page's (design review).
  await voiceOver.nextHeading();
  const formHeading = await voiceOver.lastSpokenPhrase();
  expect(formHeading).toMatch(/\bheading\b/i);
  expect(formHeading).toMatch(/\blevel 2\b/i);
  expect(formHeading).toContain("Save a link");

  // Newest first, and each title is a link.
  for (const title of ["Newer guide", "Older guide"]) {
    await voiceOver.nextHeading();
    const item = await voiceOver.lastSpokenPhrase();
    expect(item).toMatch(/\bheading\b/i);
    expect(item).toMatch(/\blevel 2\b/i);
    expect(item).toMatch(/\blink\b/i);
    expect(item).toContain(title);
  }
});
