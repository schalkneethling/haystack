// The search page's voice input (#216): a button next to the field that starts the browser's
// speech recognition, which the page adds only when the browser has it, and which puts what it
// heard in the field for the person to check, never searching on its own. Playwright's Chromium
// has a real `SpeechRecognition`, and a test can't use a microphone, so every test here either
// replaces the constructor with the stub in speech-recognition.ts or removes it. Logging whether a
// query was spoken or typed is #217's. The design's checks, axe, html-validate, 320 px and forced
// colors, are in design.e2e.ts with the search page's other states.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { answerSearches, SEARCH_STATUS } from "./search-answers.ts";
import {
  endListening,
  failWith,
  hear,
  hearNoMatch,
  latestRecognition,
  recognitionCount,
  type RecognitionErrorCode,
  type RecognitionName,
  removeSpeechRecognition,
  startListening,
  stubSpeechRecognition,
  VOICE_MESSAGES,
  VOICE_NAME,
  VOICE_STATUS,
} from "./speech-recognition.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

function field(page: Page) {
  return page.getByRole("searchbox", { name: "Search your saved links" });
}

function voiceButton(page: Page) {
  return page.getByRole("button", { name: VOICE_NAME });
}

function voiceStatus(page: Page) {
  return page.getByRole("status").and(page.locator(VOICE_STATUS));
}

/** Opens the search page with the stub, and presses the button, which makes a recognition. */
async function pressToListen(page: Page): Promise<void> {
  await page.goto("/");
  await voiceButton(page).click();
  await expect.poll(() => recognitionCount(page)).toBe(1);
}

test.describe("without speech recognition", () => {
  test.beforeEach(async ({ page }) => {
    await removeSpeechRecognition(page);
  });

  test("the page is the plain text search, with no button, no disabled control and no message", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(field(page)).toBeVisible();
    // The search form holds the field and Search, and nothing else that can be pressed.
    const form = page.locator("form[data-search-form]");
    await expect(form.getByRole("button")).toHaveText(["Search"]);
    await expect(voiceButton(page)).toHaveCount(0);
    await expect(page.locator(VOICE_STATUS)).toHaveCount(0);
    await expect(page.getByText(VOICE_MESSAGES.privacy)).toHaveCount(0);
    await expect(page.locator("[disabled], [aria-disabled]")).toHaveCount(0);
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the page has no button and no privacy note", async ({ page }) => {
    await page.goto("/");
    await expect(field(page)).toBeVisible();
    await expect(voiceButton(page)).toHaveCount(0);
    await expect(page.getByText(VOICE_MESSAGES.privacy)).toHaveCount(0);
  });
});

test.describe("with speech recognition", () => {
  // Chrome has both names since 139, and Safari has only the prefixed one (MDN's compatibility
  // data, checked 2026-11-05), so the page must find either.
  for (const names of [
    ["SpeechRecognition", "webkitSpeechRecognition"],
    ["SpeechRecognition"],
    ["webkitSpeechRecognition"],
  ] as const satisfies readonly (readonly RecognitionName[])[]) {
    test(`the button is added when the browser has ${names.join(" and ")}`, async ({ page }) => {
      await stubSpeechRecognition(page, names);
      await page.goto("/");
      await expect(voiceButton(page)).toBeVisible();
      await voiceButton(page).click();
      await expect.poll(() => recognitionCount(page)).toBe(1);
    });
  }

  test.describe("under both names", () => {
    test.beforeEach(async ({ page }) => {
      await stubSpeechRecognition(page);
    });

    test("the button sits after the field, is named, is described by the privacy note, and isn't pressed", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(voiceButton(page)).toBeVisible();
      // The button comes straight after the field, in the field's row.
      expect(
        await field(page).evaluate(
          (input) => input.nextElementSibling?.getAttribute("aria-label") ?? null,
        ),
      ).toBe(VOICE_NAME);
      await expect(page.getByText(VOICE_MESSAGES.privacy)).toBeVisible();
      await expect(voiceButton(page)).toHaveAccessibleDescription(VOICE_MESSAGES.privacy);
      await expect(page.locator("form[data-search-form]")).toMatchAriaSnapshot(`
        - searchbox "Search your saved links"
        - button "${VOICE_NAME}" [pressed=false]
        - button "Search"
      `);
      // The listening message's live region is in the page from the start, and empty.
      await expect(voiceStatus(page)).toBeEmpty();
    });

    test("the button is reached by Tab after the field, shows the focus ring, and works with Space and Enter", async ({
      page,
    }) => {
      await page.goto("/");
      await field(page).focus();
      await page.keyboard.press("Tab");
      await expect(voiceButton(page)).toBeFocused();
      await expect(voiceButton(page)).toHaveCSS("outline-style", "solid");
      await expect(voiceButton(page)).toHaveCSS("outline-width", "3px");
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Search", exact: true })).toBeFocused();
      await page.keyboard.press("Shift+Tab");

      // Space starts listening.
      await page.keyboard.press("Space");
      await expect.poll(() => recognitionCount(page)).toBe(1);
      expect((await latestRecognition(page))?.calls).toEqual(["start"]);
      await startListening(page);
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "true");
      // Enter, while it listens, stops it.
      await page.keyboard.press("Enter");
      expect((await latestRecognition(page))?.calls).toEqual(["start", "stop"]);
      await hear(page, "rust error handling");
      await expect(field(page)).toHaveValue("rust error handling");
      // Focus stays on the button, so Tab moves on to Search.
      await expect(voiceButton(page)).toBeFocused();
    });

    test("pressing it starts a recognition in the browser's language, for one final result", async ({
      page,
    }) => {
      await page.goto("/");
      await voiceButton(page).click();
      await expect.poll(() => recognitionCount(page)).toBe(1);
      const language = await page.evaluate(() => navigator.language);
      expect(await latestRecognition(page)).toEqual({
        lang: language,
        continuous: false,
        interimResults: false,
        maxAlternatives: 1,
        calls: ["start"],
      });
    });

    test("the listening state is shown and exposed only once the browser listens, and goes when it ends", async ({
      page,
    }) => {
      await pressToListen(page);
      // The browser may still be asking for the microphone, so nothing says it listens yet.
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
      await expect(voiceStatus(page)).toBeEmpty();

      await startListening(page);
      await expect(page.locator("form[data-search-form]")).toMatchAriaSnapshot(`
        - searchbox "Search your saved links"
        - button "${VOICE_NAME}" [pressed]
        - button "Search"
        - status:
          - paragraph: ${VOICE_MESSAGES.listening}
      `);

      await endListening(page);
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
      await expect(voiceStatus(page)).toBeEmpty();
    });

    test("pressing it again while it listens stops listening, and a later press listens again", async ({
      page,
    }) => {
      await pressToListen(page);
      await startListening(page);
      await voiceButton(page).click();
      expect((await latestRecognition(page))?.calls).toEqual(["start", "stop"]);
      await endListening(page);
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");

      await voiceButton(page).click();
      await expect.poll(() => recognitionCount(page)).toBe(2);
      expect((await latestRecognition(page))?.calls).toEqual(["start"]);
    });

    test("what it heard fills the field, and nothing is searched until the person presses Search", async ({
      page,
    }) => {
      const searches = await answerSearches(page, () => [{ title: "Rust error handling" }]);
      await page.goto("/");
      await field(page).fill("something typed before");
      await voiceButton(page).click();
      await startListening(page);
      await hear(page, "  rust error handling ");

      await expect(field(page)).toHaveValue("rust error handling");
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
      await expect(voiceStatus(page)).toHaveText(VOICE_MESSAGES.heard);
      // The search's own live region says nothing, because no search started.
      await expect(page.locator(SEARCH_STATUS)).toBeEmpty();
      expect(searches).toHaveLength(0);

      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
      expect(searches.map(({ body }) => body)).toEqual([{ query: "rust error handling" }]);
      // Searching ends the message about what was heard, which no longer describes the field.
      await expect(voiceStatus(page)).toBeEmpty();
    });

    test("typing in the field after a transcript ends the message about it", async ({ page }) => {
      await pressToListen(page);
      await startListening(page);
      await hear(page, "rust error handling");
      await expect(voiceStatus(page)).toHaveText(VOICE_MESSAGES.heard);
      // Any edit fires `input`, which ends the message.
      await field(page).fill("rust error handling in tests");
      await expect(voiceStatus(page)).toBeEmpty();
    });

    test("a transcript longer than the field allows is cut to the field's limit", async ({
      page,
    }) => {
      await pressToListen(page);
      await startListening(page);
      await hear(page, "word ".repeat(150));
      await expect(field(page)).toHaveAttribute("maxlength", "500");
      expect((await field(page).inputValue()).length).toBe(500);
    });

    // The three errors the issue names, each of which ends listening with its message next to the
    // field. Permission is refused before the browser listens, so that error comes without a
    // `start` event.
    for (const [error, message, listened] of [
      ["not-allowed", VOICE_MESSAGES.notAllowed, false],
      ["no-speech", VOICE_MESSAGES.noSpeech, true],
      ["network", VOICE_MESSAGES.network, true],
    ] as const satisfies readonly (readonly [RecognitionErrorCode, string, boolean])[]) {
      test(`the ${error} error ends listening and says "${message}"`, async ({ page }) => {
        await pressToListen(page);
        await field(page).fill("kept as typed");
        if (listened) {
          await startListening(page);
          await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "true");
        }
        await failWith(page, error);
        await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
        await expect(voiceStatus(page).locator(".alert")).toHaveText(message);
        await expect(field(page)).toHaveValue("kept as typed");
      });
    }

    test("a result with nothing recognized says so, like no speech, and leaves the field alone", async ({
      page,
    }) => {
      await pressToListen(page);
      await field(page).fill("kept as typed");
      await startListening(page);
      await hearNoMatch(page);
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
      await expect(voiceStatus(page).locator(".alert")).toHaveText(VOICE_MESSAGES.noSpeech);
      await expect(field(page)).toHaveValue("kept as typed");
    });

    test("an empty transcript says so, like no speech, and leaves the field alone", async ({
      page,
    }) => {
      await pressToListen(page);
      await field(page).fill("kept as typed");
      await startListening(page);
      await hear(page, "   ");
      await expect(voiceStatus(page).locator(".alert")).toHaveText(VOICE_MESSAGES.noSpeech);
      await expect(field(page)).toHaveValue("kept as typed");
    });

    test("any other error ends listening with the general message", async ({ page }) => {
      await pressToListen(page);
      await startListening(page);
      await failWith(page, "audio-capture");
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
      await expect(voiceStatus(page).locator(".alert")).toHaveText(VOICE_MESSAGES.unavailable);
    });

    // `aborted` is what a browser reports when listening was cancelled, by the page or by the
    // browser's own controls, so it ends listening without a message.
    test("an aborted recognition ends listening without a message", async ({ page }) => {
      await pressToListen(page);
      await startListening(page);
      await failWith(page, "aborted");
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
      await expect(voiceStatus(page)).toBeEmpty();
    });

    test("pressing it again after an error listens again, and the error goes", async ({ page }) => {
      await pressToListen(page);
      await startListening(page);
      await failWith(page, "no-speech");
      await expect(voiceStatus(page).locator(".alert")).toHaveText(VOICE_MESSAGES.noSpeech);
      await voiceButton(page).click();
      await expect.poll(() => recognitionCount(page)).toBe(2);
      await startListening(page);
      await expect(voiceStatus(page)).toHaveText(VOICE_MESSAGES.listening);
    });
  });
});
