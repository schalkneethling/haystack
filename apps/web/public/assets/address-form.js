// @ts-check
// Sends the address form with `fetch` while the Worker looks the page up, which can take a few
// seconds (#105; plan, "The address form (#97)"). Without this script the browser posts the form
// to the same route and follows its 303, so the form works without it. Only a form that posts
// looks a page up: the form shown before sign-in asks for GET /save, so this leaves it alone.
//
// - Continue's label says the form is processing. The button is never disabled, with
//   `disabled` or `aria-disabled`: it keeps focus, a screen reader does not call it dimmed, and a
//   second press is handled here instead. The same address is ignored; a changed one replaces the
//   request in flight.
// - The route answers JSON (`Accept: application/json`): the save link to go to, or a rejected
//   address's error, which is shown as the server shows it, with focus on the field.
// - While the lookup runs, and when it fails (a timeout, a network error, a signed-out session or
//   any other answer), a message in the form's status region takes focus, so a screen reader
//   reads it, and the form is ready to try again.

const FIELD_ID = "save-url";
const HINT_ID = "save-url-hint";
const ERROR_ID = "save-url-error";
const STATUS_ID = "save-url-status";
// The page's message bar, which holds the status and the error: MESSAGE_BAR_ID in
// apps/worker/src/notices.ts.
const MESSAGE_BAR_ID = "messages";

const PROCESSING_LABEL = "Processing…";

// What the status region says, and when. Each message is written ANNOUNCE_DELAY_MS after the
// change that comes with it, such as the button's new label, and focused. On CI (Playwright's
// WebKit on macOS 26), VoiceOver read a message focused 100 ms after the press every time, and
// missed it every time as a polite status, as an alert, as an assertive live region, and when
// focus left Continue and came back (plan, "The address form (#97)", has the runs). The delay
// and the messages are kept here, so they are easy to change.
const ANNOUNCE_DELAY_MS = 100;
const MESSAGES = {
  processing: "Looking up the page. This can take a few seconds.",
  timeout: "Looking up the page took too long. You can press Continue to try again.",
  network:
    "Haystack could not be reached. Check your connection, then press Continue to try again.",
  unexpected:
    "Something went wrong while looking up the page. You can press Continue to try again.",
  signedOut: "You are signed out, so the page could not be looked up.",
  signIn: "Sign in again",
};

// The Worker's lookup stops after 3 s, so an answer that takes longer than this is not coming.
// The timer is an ordinary setTimeout that aborts the request, rather than AbortSignal.timeout,
// so that the same AbortController ends the request either way, and a test's clock can reach it.
const TIMEOUT_MS = 10_000;

/**
 * @typedef {{ kind: "go", link: string }
 *   | { kind: "rejected", error: string, keepValue: boolean, title: string }
 *   | { kind: "timeout" | "network" | "signedOut" | "unexpected" }} Outcome
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * The save link from a success answer, if it is a link to this origin's save form. Anything else
 * is not followed.
 * @param {unknown} body
 */
function saveLinkIn(body) {
  const link = isRecord(body) && typeof body.saveLink === "string" ? body.saveLink : null;
  if (link === null) {
    return null;
  }
  // The URL constructor, not URL.parse, which Safari before 17.4 and Chrome and Firefox before
  // 126 do not have.
  /** @type {URL} */
  let url;
  try {
    url = new URL(link, window.location.href);
  } catch {
    return null;
  }
  return url.origin === window.location.origin && url.pathname === "/save" ? url.href : null;
}

/**
 * What an answer means.
 * @param {Response} response
 * @returns {Promise<Outcome>}
 */
async function outcomeOf(response) {
  if (response.status === 401) {
    return { kind: "signedOut" };
  }
  /** @type {unknown} */
  let body = null;
  if ((response.headers.get("content-type") ?? "").startsWith("application/json")) {
    body = await response.json().catch(() => null);
  }
  if (response.status === 200) {
    const link = saveLinkIn(body);
    return link === null ? { kind: "unexpected" } : { kind: "go", link };
  }
  if (
    response.status === 400 &&
    isRecord(body) &&
    typeof body.error === "string" &&
    typeof body.keepValue === "boolean" &&
    typeof body.title === "string"
  ) {
    return { kind: "rejected", error: body.error, keepValue: body.keepValue, title: body.title };
  }
  return { kind: "unexpected" };
}

/**
 * @param {HTMLFormElement} form
 * @param {HTMLInputElement} field
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} status
 */
function enhance(form, field, button, status) {
  const idleLabel = button.textContent ?? "";
  /** @type {{ address: string, controller: AbortController } | null} */
  let inFlight = null;
  // The address whose save link the browser is opening. Until the save form loads, this page
  // stays interactive, and the same address must not be looked up again: the lookup fetches
  // someone else's page, which is why it runs once, on a POST.
  /** @type {string | null} */
  let leavingFor = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let announceTimer;
  // Whether the current lookup's processing message has been written, so that the user has had
  // the chance to move on from it.
  let processingShown = false;

  // The message is how the script announces, by focus, so the region is not also a live region
  // once the script runs: NVDA, JAWS and TalkBack would read a focused message in a live region
  // twice. aria-live is a global attribute, and its explicit value overrides the role's implicit
  // "polite". Without the script nothing writes to the region, so the server leaves it as it is.
  status.setAttribute("aria-live", "off");

  // Whether a message may take focus when it is written. Focus on nothing, as after a click in
  // Safari, which does not focus a clicked button, can always go to it. Otherwise:
  // - The processing message follows a press of Continue, or of Enter in the field, so it may
  //   take focus from anywhere in the form.
  // - A failure's message may take focus only from Continue or from the message it replaces.
  //   A user who went back to the field while the lookup ran is typing there, and keeps it.
  // A user who has moved elsewhere keeps their place, and the message is written without focus.
  /** @param {"processing" | "failure"} kind */
  function mayTakeFocus(kind) {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      return true;
    }
    return kind === "processing"
      ? form.contains(active)
      : active === button || status.contains(active);
  }

  // Writes a message in the status region ANNOUNCE_DELAY_MS from now, replacing the one there,
  // and focuses it when it may, so a screen reader reads it (see MESSAGES). The message there
  // until then stays, so focus does not fall to the page in between. The paragraph is focusable
  // by script only (tabindex -1).
  /**
   * @param {"processing" | "failure"} kind
   * @param {(Node | string)[]} content
   */
  function announce(kind, ...content) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      const takeFocus = mayTakeFocus(kind);
      const message = document.createElement("p");
      message.append(...content);
      message.tabIndex = -1;
      status.replaceChildren(message);
      if (takeFocus) {
        message.focus();
      }
      if (kind === "processing") {
        processingShown = true;
      }
    }, ANNOUNCE_DELAY_MS);
  }

  // Clears the status region at once, with no message to say.
  function clearMessage() {
    clearTimeout(announceTimer);
    status.replaceChildren();
  }

  // The page's title without an error, to go back to when the error is cleared. A page that the
  // server rendered with an error has another title, so the server puts its error-free title on
  // the form.
  const idleTitle =
    document.getElementById(ERROR_ID) === null
      ? document.title
      : (form.dataset.idleTitle ?? document.title);
  // The rejected address's error, in the markup the server renders: an alert holding the
  // paragraph that the field's description points at, error first, then the hint. On both pages
  // the alert comes first in the page's message bar, as the server renders it. The page's
  // title changes with it, to the title the server gives the address form with an error, which
  // the answer carries, and back when the error is cleared.
  /** @param {{ text: string, title: string } | null} error */
  function showError(error) {
    const existing = document.getElementById(ERROR_ID);
    if (error === null) {
      existing?.closest(".alert")?.remove();
      field.removeAttribute("aria-invalid");
      field.setAttribute("aria-describedby", HINT_ID);
      document.title = idleTitle;
      return;
    }
    const { text, title } = error;
    document.title = title;
    if (existing === null) {
      const alert = document.createElement("div");
      alert.className = "alert";
      alert.setAttribute("role", "alert");
      const paragraph = document.createElement("p");
      paragraph.id = ERROR_ID;
      paragraph.textContent = text;
      alert.append(paragraph);
      const bar = document.getElementById(MESSAGE_BAR_ID);
      if (bar === null) {
        form.before(alert);
      } else {
        bar.prepend(alert);
      }
    } else {
      existing.textContent = text;
    }
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", `${ERROR_ID} ${HINT_ID}`);
  }

  // Continue's label, and the processing message while a lookup runs.
  function startProcessing() {
    button.textContent = PROCESSING_LABEL;
    processingShown = false;
    announce("processing", MESSAGES.processing);
  }

  // The form as it is before a lookup: Continue's own label, and no message.
  function reset() {
    button.textContent = idleLabel;
    clearMessage();
  }

  /**
   * @param {Outcome} outcome
   * @param {string} address The address that was sent.
   */
  function settle(outcome, address) {
    if (outcome.kind === "go") {
      // The form stays as it is while the save form loads.
      leavingFor = address;
      window.location.assign(outcome.link);
      return;
    }
    if (outcome.kind === "rejected") {
      reset();
      // A value that must not stay is the address that was sent. A field that holds something
      // else by now, because the user went on typing, is left as it is.
      if (!outcome.keepValue && field.value === address) {
        field.value = "";
      }
      showError({ text: outcome.error, title: outcome.title });
      field.focus();
      return;
    }
    // A failure's message replaces the processing message, which keeps focus until then, and
    // says what to do next. A failure that comes before the processing message was written is
    // the first message after the press, so it follows the processing message's rule.
    button.textContent = idleLabel;
    const kind = processingShown ? "failure" : "processing";
    if (outcome.kind === "signedOut") {
      const link = document.createElement("a");
      link.href = `/auth/sign-in?return_to=${encodeURIComponent(window.location.pathname)}`;
      link.textContent = MESSAGES.signIn;
      announce(kind, `${MESSAGES.signedOut} `, link, ".");
      return;
    }
    announce(kind, MESSAGES[outcome.kind]);
  }

  /** @param {string} address */
  async function send(address) {
    const controller = new AbortController();
    const request = { address, controller };
    inFlight = request;
    leavingFor = null;
    showError(null);
    startProcessing();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    /** @type {Outcome} */
    let outcome;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { accept: "application/json" },
        body: new URLSearchParams({ url: address }),
        signal: controller.signal,
      });
      outcome = await outcomeOf(response);
    } catch {
      outcome = { kind: timedOut ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
    // A request that a newer one replaced, or that a restored page dropped, says nothing.
    if (inFlight !== request) {
      return;
    }
    inFlight = null;
    settle(outcome, address);
  }

  // A press of Continue or Enter in the field submits the form. The browser's own submission is
  // stopped, and the same address that is already being looked up, or whose save form is
  // loading, is not sent again.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const address = field.value;
    if (inFlight?.address === address || leavingFor === address) {
      return;
    }
    inFlight?.controller.abort();
    void send(address);
  });

  // Going back from the save form can restore this page from the back-forward cache as it was
  // left, still processing, so it is made ready again, and says nothing.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      inFlight?.controller.abort();
      inFlight = null;
      leavingFor = null;
      reset();
    }
  });
}

const form = document.querySelector('form.address-form[method="post"]');
const field = document.getElementById(FIELD_ID);
const button = form?.querySelector('button[type="submit"]');
const status = document.getElementById(STATUS_ID);
if (
  form instanceof HTMLFormElement &&
  field instanceof HTMLInputElement &&
  button instanceof HTMLButtonElement &&
  status !== null
) {
  enhance(form, field, button, status);
}
