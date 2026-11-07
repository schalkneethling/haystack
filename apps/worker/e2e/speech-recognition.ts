// Replaces the browser's speech recognition in the page with a stub, for the voice input's tests
// (#216). A test can't use a real microphone, and Playwright's Chromium has a real
// `SpeechRecognition`, so the stub is installed with an init script, before any page script runs,
// under both of the names that voice-input.js looks for, or only one of them. The stub records
// what the page set and called, and does nothing on its own: the test makes it start listening,
// hear a transcript, fail or end, through the functions below, which fire the events a browser
// fires, in the order the Web Speech API specification gives them
// (https://webaudio.github.io/web-speech-api/): `start` once the service listens, then `result`,
// `nomatch` or `error`, and always `end` last.
import type { Page } from "@playwright/test";

/** The voice button's accessible name. */
export const VOICE_NAME = "Search by voice";

/** The live region next to the field that holds the voice input's messages. */
export const VOICE_STATUS = "#voice-status";

/** What voice-input.js says, in its live region and in the privacy note under it. */
export const VOICE_MESSAGES = {
  listening: "Listening. Say what you're looking for, then pause.",
  heard: "Check what was heard in the field, then press Search.",
  notAllowed:
    "This browser isn't allowing Haystack to use the microphone. You can type your search instead.",
  noSpeech: "No speech was recognized. You can try again, or type your search.",
  network:
    "Speech recognition couldn't reach its service. Check your connection, or type your search.",
  unavailable:
    "Searching by voice isn't working in this browser right now. You can type your search instead.",
  privacy:
    "In some browsers, including Chrome, searching by voice sends a recording of what you say to the browser maker's servers, which turn it into text.",
} as const;

/** The names a browser gives the constructor: Chrome has both since 139, Safari only the prefix. */
export type RecognitionName = "SpeechRecognition" | "webkitSpeechRecognition";

/** The error codes of the specification's `SpeechRecognitionErrorCode`. */
export type RecognitionErrorCode =
  | "no-speech"
  | "aborted"
  | "audio-capture"
  | "network"
  | "not-allowed"
  | "service-not-allowed"
  | "language-not-supported"
  | "phrases-not-supported";

/** What the page set on the latest recognition before it started it, and what it called. */
export interface RecognitionRecord {
  readonly lang: string;
  readonly continuous: boolean;
  readonly interimResults: boolean;
  readonly maxAlternatives: number;
  readonly calls: readonly string[];
}

/** The stub's handle in the page, which only these helpers use. */
interface SpeechStub {
  readonly instances: (EventTarget & { record(): RecognitionRecord })[];
}

declare global {
  interface Window {
    speechStub?: SpeechStub;
  }
}

/** How the stub behaves, beyond the names it is installed under. */
export interface StubOptions {
  /**
   * Whether `start()` throws, as a browser's can for a reason the page can't see. Off by
   * default.
   */
  readonly startThrows?: boolean;
}

/**
 * Installs the stub under `names` (both by default), and removes the browser's own constructor
 * under the other name, so the page sees exactly what a browser with those names has.
 */
export async function stubSpeechRecognition(
  page: Page,
  names: readonly RecognitionName[] = ["SpeechRecognition", "webkitSpeechRecognition"],
  { startThrows = false }: StubOptions = {},
): Promise<void> {
  await page.addInitScript(
    ({ installed, throwsOnStart }) => {
      const instances: SpeechStub["instances"] = [];
      class StubRecognition extends EventTarget {
        lang = "";
        continuous = false;
        interimResults = false;
        maxAlternatives = 1;
        readonly calls: string[] = [];
        // Whether a session started by `start()` is still running: until its `end` event.
        running = false;
        constructor() {
          super();
          instances.push(this);
          this.addEventListener("end", () => {
            this.running = false;
          });
        }
        start() {
          this.calls.push("start");
          if (throwsOnStart) {
            throw new DOMException("The stub refuses to start.", "InvalidStateError");
          }
          // The specification throws `InvalidStateError` only while a session is still running,
          // and allows a restart after its `end` event, so a page that starts one twice is caught.
          if (this.running) {
            throw new DOMException("The recognition has already started.", "InvalidStateError");
          }
          this.running = true;
        }
        stop() {
          this.calls.push("stop");
        }
        abort() {
          this.calls.push("abort");
        }
        record() {
          const { lang, continuous, interimResults, maxAlternatives, calls } = this;
          return { lang, continuous, interimResults, maxAlternatives, calls: [...calls] };
        }
      }
      for (const name of ["SpeechRecognition", "webkitSpeechRecognition"]) {
        Reflect.deleteProperty(window, name);
      }
      for (const name of installed) {
        Object.defineProperty(window, name, {
          configurable: true,
          writable: true,
          value: StubRecognition,
        });
      }
      window.speechStub = { instances };
    },
    { installed: names, throwsOnStart: startThrows },
  );
}

/** Removes both constructors, as in a browser without speech recognition. */
export async function removeSpeechRecognition(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "SpeechRecognition");
    Reflect.deleteProperty(window, "webkitSpeechRecognition");
  });
}

/** How many recognitions the page has made. */
export function recognitionCount(page: Page): Promise<number> {
  return page.evaluate(() => window.speechStub?.instances.length ?? 0);
}

/** What the page set on its latest recognition, and what it called on it. */
export function latestRecognition(page: Page): Promise<RecognitionRecord | null> {
  return page.evaluate(() => window.speechStub?.instances.at(-1)?.record() ?? null);
}

/**
 * Which recognition a helper fires its events on: the index of the page's recognitions, in the
 * order the page made them. Left out, it is the latest.
 */
export interface Target {
  readonly instance?: number;
}

/**
 * Fires `events` on a recognition, in order. Each is an event's type and the properties a
 * browser gives that event, such as an error event's `error`.
 */
function fire(
  page: Page,
  events: readonly (readonly [string, Record<string, unknown>?])[],
  { instance = -1 }: Target = {},
): Promise<void> {
  return page.evaluate(
    ([list, index]) => {
      const recognition = window.speechStub?.instances.at(index);
      if (recognition === undefined) {
        throw new Error(`The page has made no recognition ${index}`);
      }
      for (const [type, properties = {}] of list) {
        const event = new Event(type);
        for (const [key, value] of Object.entries(properties)) {
          Object.defineProperty(event, key, { value });
        }
        recognition.dispatchEvent(event);
      }
    },
    [events, instance] as const,
  );
}

/** The recognition service has begun to listen: its `start` event. */
export function startListening(page: Page, target?: Target): Promise<void> {
  return fire(page, [["start"]], target);
}

/**
 * The service heard `transcript` as one final result, then ended, as a recognition that is not
 * continuous does after a pause. The results are arrays with `isFinal` set, which index and
 * measure as a `SpeechRecognitionResultList` and a `SpeechRecognitionResult` do.
 */
export async function hear(page: Page, transcript: string): Promise<void> {
  await page.evaluate((text) => {
    const recognition = window.speechStub?.instances.at(-1);
    if (recognition === undefined) {
      throw new Error("The page has made no recognition");
    }
    const result = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: true });
    const event = new Event("result");
    Object.defineProperties(event, { resultIndex: { value: 0 }, results: { value: [result] } });
    recognition.dispatchEvent(event);
    recognition.dispatchEvent(new Event("end"));
  }, transcript);
}

/** The service failed with `error`, then ended, as the specification orders the two events. */
export function failWith(page: Page, error: RecognitionErrorCode, target?: Target): Promise<void> {
  return fire(page, [["error", { error, message: "" }], ["end"]], target);
}

/** The service failed with `error`, without the `end` that follows it, which a test sends later. */
export function failWithoutEnd(
  page: Page,
  error: RecognitionErrorCode,
  target?: Target,
): Promise<void> {
  return fire(page, [["error", { error, message: "" }]], target);
}

/** The service returned a final result with no hypothesis it was confident in, then ended. */
export function hearNoMatch(page: Page): Promise<void> {
  return fire(page, [["nomatch", { resultIndex: 0, results: [] }], ["end"]]);
}

/** The service ended without a result, as it does after `stop()` with nothing heard. */
export function endListening(page: Page, target?: Target): Promise<void> {
  return fire(page, [["end"]], target);
}
