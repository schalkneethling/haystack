// @ts-check
// Voice input for the search page (#216; plan, "Search page", "Voice"). It adds a button next to
// the search field that starts the browser's own speech recognition, and puts what was heard in
// the field for the person to check. It never searches on its own: the person presses Search, as
// for a typed query. search.js calls `addVoiceInput` once it has enhanced the page, so a page
// whose search isn't working has no button either.
//
// - Feature detection. The button is added only when the browser has a speech recognition
//   constructor, `SpeechRecognition` or the prefixed `webkitSpeechRecognition`. Chrome has both
//   since 139 and Safari only the prefixed one (MDN's browser-compat-data 8.1.8, checked
//   2026-11-05). Without either, nothing is added: no button, no message and no privacy note.
// - The button is a toggle, named "Search by voice", with `aria-pressed`. It is pressed while
//   the browser listens, which the recognition's `start` event says, so it never claims to listen
//   while the browser is still asking for the microphone. A press before then is ignored,
//   because the browser's prompt is the place to cancel. Pressing it while it is pressed stops
//   listening, which still returns what was heard. The `end` event, which the specification
//   fires whatever ended the session, gives it back. Focus stays on it throughout, so Tab moves
//   on to Search.
// - Typing in the field or submitting the form while the browser listens cancels listening
//   (`abort()`), so a result that arrives later never replaces what the person typed or the
//   query whose results the page shows.
// - Messages go to a live region of their own, next to the field: that it is listening, what to
//   do with what was heard, and why it stopped. It is added on the first press, so a person who
//   never presses the button has no second live region. The page's other live region is in the
//   message bar, above the form, and holds the search's own messages.
// - The privacy note under the field says where the audio goes, and describes the button, so a
//   screen reader reads it with the button, before the person speaks.

/**
 * The parts of a speech recognition that this module uses. TypeScript's DOM library has the
 * events' types but not the recognition's own, so it is written out here from the Web Speech API
 * specification (https://webaudio.github.io/web-speech-api/).
 * @typedef {EventTarget & {
 *   lang: string,
 *   continuous: boolean,
 *   interimResults: boolean,
 *   maxAlternatives: number,
 *   start(): void,
 *   stop(): void,
 *   abort(): void,
 * }} Recognition
 * @typedef {new () => Recognition} RecognitionConstructor
 */

const NAME = "Search by voice";
const STATUS_ID = "voice-status";
const PRIVACY_ID = "voice-privacy";

const MESSAGES = {
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
};

/**
 * The message for each error code of the specification's `SpeechRecognitionErrorCode`, or null
 * for `aborted`, which a browser reports when listening was cancelled, by the page or by the
 * browser's own controls, so there is nothing to explain. A code this doesn't name gets the
 * general message, so listening never ends without one.
 * @param {string} code
 * @returns {string | null}
 */
function errorMessage(code) {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
      return MESSAGES.notAllowed;
    case "no-speech":
      return MESSAGES.noSpeech;
    case "network":
      return MESSAGES.network;
    default:
      return MESSAGES.unavailable;
  }
}

/**
 * The browser's speech recognition constructor, unprefixed or prefixed, or null without one.
 * @returns {RecognitionConstructor | null}
 */
function recognitionConstructor() {
  for (const name of ["SpeechRecognition", "webkitSpeechRecognition"]) {
    /** @type {unknown} */
    const found = Reflect.get(window, name);
    if (typeof found === "function") {
      return /** @type {RecognitionConstructor} */ (found);
    }
  }
  return null;
}

const SVG = "http://www.w3.org/2000/svg";

/**
 * An SVG element with its attributes.
 * @param {string} tag
 * @param {Record<string, string>} attributes
 */
function svgElement(tag, attributes) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  return node;
}

/**
 * The button's icon, in inline SVG, because the CSP allows no images: a microphone, and a stop
 * square that site.css shows instead while the button is pressed, so the listening state is not
 * color alone. Both are drawn in `currentColor`, so forced colors give them the button's text
 * color. The button's name says what it does, so the icon is hidden from assistive technology.
 */
function icon() {
  const svg = svgElement("svg", {
    class: "voice-icon",
    viewBox: "0 0 24 24",
    "aria-hidden": "true",
  });
  const microphone = svgElement("g", {
    class: "voice-icon-microphone",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
  });
  microphone.append(
    svgElement("rect", { x: "9", y: "3", width: "6", height: "11", rx: "3", fill: "currentColor" }),
    svgElement("path", { d: "M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" }),
  );
  const stop = svgElement("rect", {
    class: "voice-icon-stop",
    x: "7",
    y: "7",
    width: "10",
    height: "10",
    rx: "1.5",
    fill: "currentColor",
  });
  svg.append(microphone, stop);
  return svg;
}

/**
 * The transcript of a result event's final results, joined, from its `resultIndex` on. A
 * recognition that isn't continuous returns one final result.
 * @param {Event} event
 */
function transcriptOf(event) {
  if (!("results" in event) || !("resultIndex" in event)) {
    return "";
  }
  const { results, resultIndex } = /** @type {SpeechRecognitionEvent} */ (event);
  let transcript = "";
  for (let index = resultIndex; index < results.length; index += 1) {
    const result = results[index];
    if (result?.isFinal) {
      transcript += result[0]?.transcript ?? "";
    }
  }
  return transcript.trim();
}

/**
 * Adds the voice button to the field's row, after the field, with its live region and the
 * privacy note after the row, when the browser has speech recognition.
 * @param {HTMLInputElement} field
 * @param {HTMLFormElement} form
 */
export function addVoiceInput(field, form) {
  const Recognizer = recognitionConstructor();
  const row = field.parentElement;
  if (Recognizer !== null && row !== null) {
    enhance(field, form, row, Recognizer);
  }
}

/**
 * Builds the voice input and wires it to the field.
 * @param {HTMLInputElement} field
 * @param {HTMLFormElement} form
 * @param {HTMLElement} row The field's row, after which the region and the note go.
 * @param {RecognitionConstructor} Recognizer The browser's speech recognition constructor.
 */
function enhance(field, form, row, Recognizer) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button voice-button";
  button.setAttribute("aria-label", NAME);
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("aria-describedby", PRIVACY_ID);
  button.append(icon());

  // The live region, which the first press adds, empty, before the row's privacy note. A screen
  // reader announces a change only to a live region that already exists, and the browser fires
  // `start` in a later task than the press, so the region is in the page before its first
  // message. Made only then, it is absent for a person who never presses the button, so the
  // search's own region is the page's only one for them. The role is on a `<div>` that holds
  // the message, as on the page's other live region.
  const status = document.createElement("div");
  status.id = STATUS_ID;
  status.className = "status voice-status";
  status.setAttribute("role", "status");

  const privacy = document.createElement("p");
  privacy.id = PRIVACY_ID;
  privacy.className = "hint voice-privacy";
  privacy.textContent = MESSAGES.privacy;

  field.after(button);
  row.after(privacy);

  /** @type {Recognition | null} */
  let recognition = null;
  // Whether the browser listens: from the recognition's `start` event to its error or `end`.
  let listening = false;

  /** @param {string} text */
  function say(text) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    status.replaceChildren(paragraph);
  }

  // An error is the alert's box, as the page's other errors are, with its icon drawn in CSS.
  /** @param {string} text */
  function warn(text) {
    const alert = document.createElement("div");
    alert.className = "alert";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    alert.append(paragraph);
    status.replaceChildren(alert);
  }

  function clear() {
    status.replaceChildren();
  }

  /** @param {boolean} isListening */
  function showListening(isListening) {
    listening = isListening;
    button.setAttribute("aria-pressed", String(isListening));
  }

  // Cancels a recognition that is running, so nothing it returns later reaches the field.
  function cancel() {
    if (recognition !== null) {
      recognition.abort();
      recognition = null;
    }
    showListening(false);
    clear();
  }

  function listen() {
    const current = new Recognizer();
    // Whether this session has said how it went: what was heard, or why it stopped.
    let reported = false;
    /** @param {() => void} report */
    function settle(report) {
      reported = true;
      report();
    }
    // The person's own language, which their browser names, rather than the page's `lang`,
    // which is the language of Haystack's words, not of the person's speech.
    current.lang = navigator.language;
    // One final result, after a pause, and no interim results, which would change the field's
    // text under the person, and under a screen reader's cursor, while they speak.
    current.continuous = false;
    current.interimResults = false;
    current.maxAlternatives = 1;
    current.addEventListener("start", () => {
      if (recognition === current) {
        showListening(true);
        say(MESSAGES.listening);
      }
    });
    current.addEventListener("result", (event) => {
      if (recognition !== current) {
        return;
      }
      const transcript = transcriptOf(event);
      if (transcript === "") {
        settle(() => warn(MESSAGES.noSpeech));
        return;
      }
      // A script's value isn't held to `maxlength`, which the search route's own cap matches, so
      // what was heard is cut to it, as typing would be.
      field.value = field.maxLength > 0 ? transcript.slice(0, field.maxLength) : transcript;
      settle(() => say(MESSAGES.heard));
    });
    current.addEventListener("nomatch", () => {
      if (recognition === current) {
        settle(() => warn(MESSAGES.noSpeech));
      }
    });
    current.addEventListener("error", (event) => {
      if (recognition !== current) {
        return;
      }
      const message = errorMessage(/** @type {SpeechRecognitionErrorEvent} */ (event).error);
      settle(() => {
        if (message === null) {
          clear();
        } else {
          warn(message);
        }
      });
      // The specification fires `end` after an error, which ends listening. This doesn't wait
      // for it, so an error always ends the listening state, whatever the browser does next.
      recognition = null;
      showListening(false);
    });
    current.addEventListener("end", () => {
      if (recognition !== current) {
        return;
      }
      recognition = null;
      showListening(false);
      // A session that ended with nothing to report, such as one stopped before anything was
      // said, takes its "Listening" message with it.
      if (!reported) {
        clear();
      }
    });
    recognition = current;
    clear();
    try {
      current.start();
    } catch {
      recognition = null;
      warn(MESSAGES.unavailable);
    }
  }

  button.addEventListener("click", () => {
    if (!status.isConnected) {
      privacy.before(status);
    }
    if (recognition === null) {
      listen();
    } else if (listening) {
      // Stops listening, and the browser still returns what it heard so far, then ends.
      recognition.stop();
    }
    // Otherwise the browser hasn't started listening, and may be asking for the microphone,
    // whose prompt is the place to cancel, so the press is ignored.
  });

  // The field's text is the person's from the moment they change it or search, so a recognition
  // still running is cancelled, and the message about what was heard, or an error's, goes.
  field.addEventListener("input", cancel);
  form.addEventListener("submit", cancel);
}
