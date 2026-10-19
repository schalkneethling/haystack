// @ts-check
// Shows that the address form is waiting while the Worker looks the page up, which can take a
// few seconds, and stops a second submission (#105; plan, "Save flow"). Without this script the
// form still submits, and the browser shows its own loading state. The server renders the form,
// the button and the empty status region this script writes to.

const PENDING_LABEL = "Looking up…";
const PENDING_MESSAGE = "Looking up the page. This can take a few seconds.";
// How long after the submission the message is written to the live region. VoiceOver missed a
// status message written in the same task as a change it was busy announcing (#56; plan,
// "Deleting bookmarks"), and the delete dialog's 100 ms is the delay that was tested.
const ANNOUNCE_DELAY_MS = 100;
// The Worker answers within its 3 s lookup limit and the time to render. A form still waiting
// after this long has had its request stopped, for example with the browser's Stop button, which
// fires no event, so it is made ready again.
const RESET_AFTER_MS = 15_000;

/**
 * @param {HTMLFormElement} form
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} status
 */
function enhance(form, button, status) {
  const idleLabel = button.textContent ?? "";
  let pending = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let announceTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let resetTimer;

  /** @param {boolean} value */
  function setPending(value) {
    pending = value;
    clearTimeout(announceTimer);
    clearTimeout(resetTimer);
    status.replaceChildren();
    button.textContent = value ? PENDING_LABEL : idleLabel;
    // aria-disabled, not disabled, so the button keeps focus if it has it, and focus does not
    // fall back to the page. The submit listener refuses a second submission instead.
    if (!value) {
      button.removeAttribute("aria-disabled");
      return;
    }
    button.setAttribute("aria-disabled", "true");
    announceTimer = setTimeout(() => {
      const message = document.createElement("p");
      message.textContent = PENDING_MESSAGE;
      status.replaceChildren(message);
    }, ANNOUNCE_DELAY_MS);
    resetTimer = setTimeout(() => setPending(false), RESET_AFTER_MS);
  }

  // The browser submits the form as usual. This only marks it as waiting, or refuses a second
  // submission while it waits.
  form.addEventListener("submit", (event) => {
    if (pending) {
      event.preventDefault();
      return;
    }
    setPending(true);
  });

  // Going back to this page can restore it from the back-forward cache as it was left, still
  // waiting, so it is made ready again.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      setPending(false);
    }
  });
}

const form = document.querySelector("form.address-form");
const button = form?.querySelector('button[type="submit"]');
const status = document.getElementById("save-url-status");
if (form instanceof HTMLFormElement && button instanceof HTMLButtonElement && status !== null) {
  enhance(form, button, status);
}
