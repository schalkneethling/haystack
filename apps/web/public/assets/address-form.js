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
// - A timeout, a network error, a signed-out session or any other answer is said in the form's
//   status region, as the delete dialog says its outcomes, and the form is ready again.

const FIELD_ID = "save-url";
const HINT_ID = "save-url-hint";
const ERROR_ID = "save-url-error";
const STATUS_ID = "save-url-status";

const PROCESSING_LABEL = "Processing…";

// What the status region says, and when. Each message is written ANNOUNCE_DELAY_MS after the
// change that comes with it, such as the button's new label, because VoiceOver missed a status
// message written in the same task as a change it was busy announcing (#56; plan, "Deleting
// bookmarks"). 100 ms is the delay that was tested then. The delete dialog has since moved to
// 500 ms after focus moves (#107); no focus moves here, and how the processing state is
// announced is being measured on CI, so the delay and the messages are kept here, easy to change.
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
  const url = link === null ? null : URL.parse(link, window.location.href);
  return url !== null && url.origin === window.location.origin && url.pathname === "/save"
    ? url.href
    : null;
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
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let announceTimer;

  /** @param {(Node | string)[]} content */
  function announce(...content) {
    clearTimeout(announceTimer);
    status.replaceChildren();
    if (content.length === 0) {
      return;
    }
    announceTimer = setTimeout(() => {
      const message = document.createElement("p");
      message.append(...content);
      status.replaceChildren(message);
    }, ANNOUNCE_DELAY_MS);
  }

  // The page's title without an error, to go back to when the error is cleared. A page that the
  // server rendered with an error has no title without one, so it keeps its own.
  const idleTitle = document.getElementById(ERROR_ID) === null ? document.title : null;

  // The rejected address's error, in the markup the server renders: an alert holding the
  // paragraph that the field's description points at, error first, then the hint. On its own
  // page the alert follows the heading, before the form; in the saved links page's card it comes
  // before the hint. The page's title changes with it, to the title the server gives the
  // address form with an error, which the answer carries, and back when the error is cleared.
  /** @param {{ text: string, title: string } | null} error */
  function showError(error) {
    const existing = document.getElementById(ERROR_ID);
    if (error === null) {
      existing?.closest(".alert")?.remove();
      field.removeAttribute("aria-invalid");
      field.setAttribute("aria-describedby", HINT_ID);
      if (idleTitle !== null) {
        document.title = idleTitle;
      }
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
      const hint = document.getElementById(HINT_ID);
      const inCard = form.querySelector(".address-form-title") !== null;
      if (inCard && hint !== null) {
        hint.before(alert);
      } else {
        form.before(alert);
      }
    } else {
      existing.textContent = text;
    }
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", `${ERROR_ID} ${HINT_ID}`);
  }

  /** @param {boolean} processing */
  function setProcessing(processing) {
    button.textContent = processing ? PROCESSING_LABEL : idleLabel;
    announce(...(processing ? [MESSAGES.processing] : []));
  }

  /** @param {Outcome} outcome */
  function settle(outcome) {
    if (outcome.kind === "go") {
      // The form stays as it is while the save form loads.
      window.location.assign(outcome.link);
      return;
    }
    setProcessing(false);
    if (outcome.kind === "rejected") {
      if (!outcome.keepValue) {
        field.value = "";
      }
      showError({ text: outcome.error, title: outcome.title });
      field.focus();
      return;
    }
    if (outcome.kind === "signedOut") {
      const link = document.createElement("a");
      link.href = `/auth/sign-in?return_to=${encodeURIComponent(window.location.pathname)}`;
      link.textContent = MESSAGES.signIn;
      announce(`${MESSAGES.signedOut} `, link, ".");
      return;
    }
    announce(MESSAGES[outcome.kind]);
  }

  /** @param {string} address */
  async function send(address) {
    const controller = new AbortController();
    const request = { address, controller };
    inFlight = request;
    showError(null);
    setProcessing(true);
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
    settle(outcome);
  }

  // A press of Continue or Enter in the field submits the form. The browser's own submission is
  // stopped, and the same address that is already being looked up is not sent again.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const address = field.value;
    if (inFlight?.address === address) {
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
      setProcessing(false);
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
