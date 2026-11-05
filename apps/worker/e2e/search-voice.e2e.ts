// The search page's voice input (#216): a button next to the field that starts the browser's
// speech recognition, which the page adds only when the browser has it, and which puts what it
// heard in the field for the person to check, never searching on its own. Playwright's Chromium
// has a real `SpeechRecognition`, and a test can't use a microphone, so every test here either
// replaces the constructor with the stub in speech-recognition.ts or removes it. The last part of
// the file searches through the Worker's own /api/search, and reads the run it logs, to show how a
// query was entered (#217). The design's checks, axe, html-validate, 320 px and forced colors, are
// in design.e2e.ts with the search page's other states.
import type { Page } from "@playwright/test";
import { expect, type HaystackWorker, test } from "./fixtures.ts";
import { answerSearches, SEARCH_STATUS, TRY_AGAIN } from "./search-answers.ts";
import { answerBy, clearCollection, seedEnriched, signedInUserId } from "./search-collection.ts";
import { SYSTEM_ONE_URL } from "../test/jev-fixture.ts";
import {
  endListening,
  failWith,
  failWithoutEnd,
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

/**
 * Opens the search page with the stub, types `typed` in the field when given, before listening,
 * because typing while it listens cancels it, and presses the button, which makes a recognition.
 */
async function pressToListen(page: Page, typed?: string): Promise<void> {
  await page.goto("/");
  if (typed !== undefined) {
    await field(page).fill(typed);
  }
  await voiceButton(page).click();
  await expect.poll(() => recognitionCount(page)).toBe(1);
}

/**
 * Answers the first search the page sends with a server error, and each one after it with a
 * result, so that Try again finds it. Returns the requests, as `answerSearches` does.
 */
function failFirstSearch(page: Page) {
  let sent = 0;
  return answerSearches(page, () => {
    sent += 1;
    return sent === 1 ? { status: 502 } : [{ title: "Rust error handling" }];
  });
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
    });

    // The voice input's live region is made on the first press, so a person who never presses
    // the button has no second live region on the page. The browser fires `start` in a later
    // task, so the region is in the page, empty, before its first message.
    test("the voice input's live region is added, empty, on the first press, before any message", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(voiceButton(page)).toBeVisible();
      await expect(page.locator(VOICE_STATUS)).toHaveCount(0);
      await voiceButton(page).click();
      await expect(voiceStatus(page)).toHaveCount(1);
      await expect(voiceStatus(page)).toBeEmpty();
      await startListening(page);
      await expect(voiceStatus(page)).toHaveText(VOICE_MESSAGES.listening);
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
      expect(searches.map(({ body }) => body)).toEqual([
        { query: "rust error handling", inputMode: "web-speech" },
      ]);
      // Searching ends the message about what was heard, which no longer describes the field.
      await expect(voiceStatus(page)).toBeEmpty();
    });

    // A transcript the person then types in is a typed query, and so is one they replace.
    test("a transcript the person types over is searched as typed", async ({ page }) => {
      const searches = await answerSearches(page, () => [{ title: "Rust error handling" }]);
      await pressToListen(page);
      await startListening(page);
      await hear(page, "rust error handling");
      await field(page).fill("rust error handling in tests");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
      expect(searches.map(({ body }) => body)).toEqual([
        { query: "rust error handling in tests", inputMode: "typed" },
      ]);
    });

    // Try again repeats the search that failed, so the search it starts keeps how that one was
    // entered: the first search fails, and the ones after it find a result.
    test("Try again repeats a spoken search as spoken", async ({ page }) => {
      const searches = await failFirstSearch(page);
      await pressToListen(page);
      await startListening(page);
      await hear(page, "rust error handling");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.getByRole("button", { name: TRY_AGAIN }).click();
      await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
      expect(searches.map(({ body }) => body)).toEqual([
        { query: "rust error handling", inputMode: "web-speech" },
        { query: "rust error handling", inputMode: "web-speech" },
      ]);
    });

    test("Try again repeats a search typed over a transcript as typed", async ({ page }) => {
      const searches = await failFirstSearch(page);
      await pressToListen(page);
      await startListening(page);
      await hear(page, "rust error handling");
      await field(page).fill("rust error handling in tests");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.getByRole("button", { name: TRY_AGAIN }).click();
      await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
      expect(searches.map(({ body }) => body)).toEqual([
        { query: "rust error handling in tests", inputMode: "typed" },
        { query: "rust error handling in tests", inputMode: "typed" },
      ]);
    });

    // Try again sends a restored spoken query as spoken. The field still holds it afterwards, so
    // searching it again repeats that mode, until the person types.
    test("searching a restored spoken query again keeps it spoken", async ({ page }) => {
      const searches = await failFirstSearch(page);
      await pressToListen(page);
      await startListening(page);
      await hear(page, "rust error handling");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.getByRole("button", { name: TRY_AGAIN })).toBeVisible();
      await field(page).press("End");
      await page.keyboard.type("s");
      await page.getByRole("button", { name: TRY_AGAIN }).click();
      await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
      await field(page).press("Enter");
      await expect.poll(() => searches.length).toBe(3);
      expect(searches.map(({ body }) => body)).toEqual([
        { query: "rust error handling", inputMode: "web-speech" },
        { query: "rust error handling", inputMode: "web-speech" },
        { query: "rust error handling", inputMode: "web-speech" },
      ]);
    });

    // A restored spoken query that the person edits is typed, even when the edit is undone and the
    // words are the same as before.
    test("typing in a restored spoken query, and undoing it, makes the next search typed", async ({
      page,
    }) => {
      const searches = await failFirstSearch(page);
      await pressToListen(page);
      await startListening(page);
      await hear(page, "rust error handling");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.getByRole("button", { name: TRY_AGAIN })).toBeVisible();
      await field(page).press("End");
      await page.keyboard.type("s");
      await page.getByRole("button", { name: TRY_AGAIN }).click();
      await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
      await field(page).press("End");
      await page.keyboard.type("s");
      await page.keyboard.press("Backspace");
      await expect(field(page)).toHaveValue("rust error handling");
      await field(page).press("Enter");
      await expect.poll(() => searches.length).toBe(3);
      expect(searches.map(({ body }) => body)).toEqual([
        { query: "rust error handling", inputMode: "web-speech" },
        { query: "rust error handling", inputMode: "web-speech" },
        { query: "rust error handling", inputMode: "typed" },
      ]);
    });

    // Selecting the transcript and typing over it is a typed query, though the text is new rather
    // than an edit at its end.
    test("a transcript the person selects and types over is searched as typed", async ({
      page,
    }) => {
      const searches = await answerSearches(page, () => [{ title: "Rust error handling" }]);
      await pressToListen(page);
      await startListening(page);
      await hear(page, "rust error handling");
      await field(page).press("ControlOrMeta+a");
      await page.keyboard.type("rust tests");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
      expect(searches.map(({ body }) => body)).toEqual([
        { query: "rust tests", inputMode: "typed" },
      ]);
    });

    // The search that failed was spoken. The person then types in the field, so its text is no
    // longer the transcript, but Try again still repeats the search as spoken.
    test("Try again repeats a spoken search as spoken, after the person typed", async ({
      page,
    }) => {
      const searches = await failFirstSearch(page);
      await pressToListen(page);
      await startListening(page);
      await hear(page, "rust error handling");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.getByRole("button", { name: TRY_AGAIN })).toBeVisible();
      await field(page).press("End");
      await page.keyboard.type("s");
      await page.getByRole("button", { name: TRY_AGAIN }).click();
      await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
      expect(searches.map(({ body }) => body)).toEqual([
        { query: "rust error handling", inputMode: "web-speech" },
        { query: "rust error handling", inputMode: "web-speech" },
      ]);
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
        await pressToListen(page, "kept as typed");
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
      await pressToListen(page, "kept as typed");
      await startListening(page);
      await hearNoMatch(page);
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
      await expect(voiceStatus(page).locator(".alert")).toHaveText(VOICE_MESSAGES.noSpeech);
      await expect(field(page)).toHaveValue("kept as typed");
    });

    test("an empty transcript says so, like no speech, and leaves the field alone", async ({
      page,
    }) => {
      await pressToListen(page, "kept as typed");
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

    // Search runs for what is in the field when the person submits, so a result that arrives
    // after that would replace the query whose results the page shows (search.js keeps the field
    // holding that query). Submitting or typing while the browser listens cancels listening.
    test("submitting while it listens cancels listening, and a late result changes nothing", async ({
      page,
    }) => {
      const searches = await answerSearches(page, () => [{ title: "Typed result" }]);
      await pressToListen(page);
      await startListening(page);
      await field(page).fill("typed query");
      await field(page).press("Enter");
      await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
      expect((await latestRecognition(page))?.calls).toContain("abort");
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
      await expect(voiceStatus(page)).toBeEmpty();

      await hear(page, "spoken words");
      await expect(field(page)).toHaveValue("typed query");
      await expect(voiceStatus(page)).toBeEmpty();
      expect(searches.map(({ body }) => body)).toEqual([
        { query: "typed query", inputMode: "typed" },
      ]);
    });

    test("typing while it listens cancels listening, and a late result changes nothing", async ({
      page,
    }) => {
      await pressToListen(page);
      await startListening(page);
      await field(page).pressSequentially("typed");
      expect((await latestRecognition(page))?.calls).toContain("abort");
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
      await expect(voiceStatus(page)).toBeEmpty();
      await hear(page, "spoken words");
      await expect(field(page)).toHaveValue("typed");
      await expect(voiceStatus(page)).toBeEmpty();
    });

    // Before `start`, the browser may be asking for the microphone, and its prompt is the place
    // to cancel. A press then would stop a recognition while the button still reads "not
    // pressed", so it is ignored.
    test("a press before the browser listens is ignored, and a press while it listens stops it", async ({
      page,
    }) => {
      await pressToListen(page);
      await voiceButton(page).click();
      expect((await latestRecognition(page))?.calls).toEqual(["start"]);
      expect(await recognitionCount(page)).toBe(1);
      await startListening(page);
      await voiceButton(page).click();
      expect((await latestRecognition(page))?.calls).toEqual(["start", "stop"]);
    });

    test("a press after an error that hasn't ended yet listens again", async ({ page }) => {
      await pressToListen(page);
      await failWithoutEnd(page, "not-allowed");
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
      await voiceButton(page).click();
      await expect.poll(() => recognitionCount(page)).toBe(2);
    });

    // An error ends listening at once, so a new press can start another recognition before the
    // first one's `end` arrives. That late `end` belongs to the first, and changes nothing.
    test("a late end of an earlier recognition leaves the new one listening", async ({ page }) => {
      await pressToListen(page);
      await startListening(page);
      await failWithoutEnd(page, "network");
      await voiceButton(page).click();
      await expect.poll(() => recognitionCount(page)).toBe(2);
      await startListening(page);
      await expect(voiceStatus(page)).toHaveText(VOICE_MESSAGES.listening);

      await endListening(page, { instance: 0 });
      await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "true");
      await expect(voiceStatus(page)).toHaveText(VOICE_MESSAGES.listening);
    });
  });
});

test.describe("with a speech recognition whose start throws", () => {
  test("pressing the button says it isn't working, and leaves it not pressed", async ({ page }) => {
    await stubSpeechRecognition(page, ["SpeechRecognition", "webkitSpeechRecognition"], {
      startThrows: true,
    });
    await page.goto("/");
    await voiceButton(page).click();
    await expect(voiceStatus(page).locator(".alert")).toHaveText(VOICE_MESSAGES.unavailable);
    await expect(voiceButton(page)).toHaveAttribute("aria-pressed", "false");
    // A second press tries again, rather than finding a recognition that never started.
    await voiceButton(page).click();
    await expect.poll(() => recognitionCount(page)).toBe(2);
  });

  // The first press adds the live region. A screen reader can miss text that is already in a
  // region when the region is added, so the message is written in a later task than the press,
  // after the region is in the page empty. A mutation observer's callback runs at the end of the
  // press's task, so what it records is the region's text in that task.
  test("the first press adds the region empty, and writes the message in a later task", async ({
    page,
  }) => {
    await stubSpeechRecognition(page, ["SpeechRecognition", "webkitSpeechRecognition"], {
      startThrows: true,
    });
    await page.goto("/");
    await page.evaluate((selector) => {
      const observer = new MutationObserver(() => {
        const region = document.querySelector(selector);
        if (region !== null) {
          document.body.dataset.voiceStatusWhenAdded = region.textContent ?? "";
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }, VOICE_STATUS);
    await voiceButton(page).click();
    await expect(page.locator("body")).toHaveAttribute("data-voice-status-when-added", "");
    await expect(voiceStatus(page).locator(".alert")).toHaveText(VOICE_MESSAGES.unavailable);
  });

  test("typing before the message is written drops it", async ({ page }) => {
    await stubSpeechRecognition(page, ["SpeechRecognition", "webkitSpeechRecognition"], {
      startThrows: true,
    });
    await page.clock.install();
    await page.goto("/");
    await voiceButton(page).click();
    await field(page).fill("typed instead");
    await page.clock.runFor(1000);
    await expect(voiceStatus(page)).toBeEmpty();
  });
});

// No stub for the search: it reaches the Worker's own route, which searches the signed-in user's
// bookmarks and asks Jev, answered by the page fixture (`pages`). The run it logs records how the
// query was entered, which these tests read from D1.
test.describe("recording how a query was entered, through the Worker's own /api/search", () => {
  test.beforeEach(async ({ run, page }) => {
    await clearCollection(run);
    await stubSpeechRecognition(page);
  });

  // The Jev answer ranks the one bookmark, whose `match_text` is `rust-guide`.
  async function seedRustGuide(
    run: HaystackWorker["run"],
    query: HaystackWorker["query"],
    pages: HaystackWorker["pages"],
  ): Promise<void> {
    await seedEnriched(run, await signedInUserId(query), "voice", [
      {
        title: "Rust error handling guide",
        matchText: "rust-guide",
        createdAt: Date.UTC(2026, 9, 1),
      },
    ]);
    pages.route(SYSTEM_ONE_URL, answerBy({ "rust-guide": { noul: 0.95, score: 2.9 } }));
  }

  test("a spoken query is searched, and its run records web-speech", async ({
    page,
    pages,
    query,
    run,
  }) => {
    await seedRustGuide(run, query, pages);
    await pressToListen(page);
    await startListening(page);
    await hear(page, "rust error handling");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
    expect(await query("SELECT query, input_mode FROM search_runs")).toEqual([
      { query: "rust error handling", input_mode: "web-speech" },
    ]);
  });

  test("a typed query is searched, and its run records typed", async ({
    page,
    pages,
    query,
    run,
  }) => {
    await seedRustGuide(run, query, pages);
    await page.goto("/");
    await field(page).fill("rust error handling");
    await field(page).press("Enter");
    await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
    expect(await query("SELECT query, input_mode FROM search_runs")).toEqual([
      { query: "rust error handling", input_mode: "typed" },
    ]);
  });

  // The same words as the transcript, typed, so the field's text still equals it: only the typing
  // makes this a typed query.
  test("a transcript the person types over, with the same words, is recorded as typed", async ({
    page,
    pages,
    query,
    run,
  }) => {
    await seedRustGuide(run, query, pages);
    await pressToListen(page);
    await startListening(page);
    await hear(page, "rust error handling");
    await field(page).press("End");
    await page.keyboard.type(" ");
    await page.keyboard.press("Backspace");
    await expect(field(page)).toHaveValue("rust error handling");
    await field(page).press("Enter");
    await expect(page.locator(SEARCH_STATUS)).toHaveText("1 saved link matches your search.");
    expect(await query("SELECT query, input_mode FROM search_runs")).toEqual([
      { query: "rust error handling", input_mode: "typed" },
    ]);
  });
});
