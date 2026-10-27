// @ts-check
// Confirms deletion in a modal dialog, and deletes in place, on the saved links page and on the
// review page at /held. Without this script, each Delete button leads to a confirmation page
// instead (plan, "Deleting bookmarks"). The server renders every other part of the page.
//
// Both pages give their heading, live region and empty state the same IDs, and mark each Delete
// button's form with `data-delete-form`, so the script leaves their other forms alone, such as
// the address form and /held's Release and Retry.

const DELETE_FORMS = "form[data-delete-form]";
const main = document.querySelector("main");
const heading = document.getElementById("list-heading");
const status = document.getElementById("list-status");
const emptyState = document.getElementById("empty-state");
// How long after closing the dialog the result is written to the live region (see the confirm
// listener).
const ANNOUNCE_DELAY_MS = 500;

/**
 * @param {string} tag
 * @param {string} [text]
 */
function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function createDialog() {
  const dialog = /** @type {HTMLDialogElement} */ (element("dialog"));
  // The classes are site.css's, as on the server-rendered pages.
  dialog.className = "delete-dialog";
  const title = element("h2", "Delete this link?");
  title.id = "delete-dialog-heading";
  const name = element("p");
  name.id = "delete-dialog-name";
  name.className = "delete-dialog-name";
  const notice = element("p", "Deleting is permanent. You can save the link again later.");
  notice.id = "delete-dialog-notice";
  notice.className = "delete-dialog-notice";
  // The dialog itself takes focus when it opens (see the submit listener), so a screen reader
  // announces it before any button, and a stray Enter neither deletes nor cancels. tabindex -1
  // makes it focusable without adding it to the Tab order.
  dialog.tabIndex = -1;
  // The link's title is part of the name, not the description: when the dialog takes focus,
  // VoiceOver reads its name and the heading, but not the description (plan, "Deleting
  // bookmarks"). The heading stays short.
  dialog.setAttribute("aria-labelledby", `${title.id} ${name.id}`);
  dialog.setAttribute("aria-describedby", notice.id);
  const confirm = /** @type {HTMLButtonElement} */ (element("button", "Delete"));
  confirm.type = "button";
  confirm.className = "button button-danger";
  const cancel = /** @type {HTMLButtonElement} */ (element("button", "Cancel"));
  cancel.type = "button";
  cancel.className = "button";
  // Cancel comes first, so it is the first button Tab and a screen reader reach, and the one
  // showModal focuses if focusing the dialog fails.
  dialog.append(title, name, notice, cancel, confirm);
  return { dialog, name, confirm, cancel };
}

/** @param {string} message */
function announce(message) {
  if (status !== null) {
    status.replaceChildren(element("p", message));
  }
}

/**
 * The item's title heading: an `h2` on the saved links page, and an `h3` on /held, whose sections
 * have the `h2`s.
 * @param {Element | null | undefined} item
 */
function titleHeading(item) {
  return item?.querySelector("h2, h3") ?? null;
}

/**
 * Focus moves to the next item's title heading, then the previous item's, then the page
 * heading. A heading is named by its text, so a screen reader reads the title on focus. A list
 * that is left empty is removed, with its section on /held, where each kind of item has one. The
 * empty state appears once no Delete button is left.
 * @param {Element} item
 */
function removeItem(item) {
  const neighbour = item.nextElementSibling ?? item.previousElementSibling;
  const target = titleHeading(neighbour) ?? heading;
  const list = item.parentElement;
  item.remove();
  if (list !== null && list.children.length === 0) {
    (list.closest("section") ?? list).remove();
  }
  if (document.querySelector(DELETE_FORMS) === null) {
    emptyState?.removeAttribute("hidden");
  }
  if (target instanceof HTMLElement) {
    target.tabIndex = -1;
    target.focus();
  }
}

if (
  main !== null &&
  document.querySelector(DELETE_FORMS) !== null &&
  typeof HTMLDialogElement === "function"
) {
  const { dialog, name, confirm, cancel } = createDialog();
  main.append(dialog);

  /** @type {HTMLFormElement | null} */
  let pending = null;
  // While a delete request runs, the dialog cannot be closed or reopened, so Cancel can never
  // look as if it stopped a delete that the server goes on to make. The buttons stay focusable
  // (aria-disabled, not disabled), so focus does not fall back to the page.
  let busy = false;

  /** @param {boolean} value */
  function setBusy(value) {
    busy = value;
    for (const button of [confirm, cancel]) {
      button.setAttribute("aria-disabled", String(value));
    }
  }

  cancel.addEventListener("click", () => {
    if (!busy) {
      dialog.close();
    }
  });
  // Escape fires `cancel` first.
  dialog.addEventListener("cancel", (event) => {
    if (busy) {
      event.preventDefault();
    }
  });

  main.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches(DELETE_FORMS)) {
      return;
    }
    event.preventDefault();
    if (busy) {
      return;
    }
    pending = form;
    const title = titleHeading(form.closest("li"))?.textContent ?? "";
    name.textContent = title;
    dialog.showModal();
    // The spec lets autofocus on the dialog do this, but Chromium (156) ignores it and focuses
    // the first button instead.
    dialog.focus();
  });

  confirm.addEventListener("click", async () => {
    const form = pending;
    const item = form?.closest("li");
    if (busy || form === null || item === null || item === undefined) {
      return;
    }
    const title = name.textContent ?? "";
    setBusy(true);
    /** @type {string} */
    let message;
    let removed = false;
    // The form's own fields go too, such as /held's return page, so the delete answers with the
    // page it started from, as it does without this script.
    const body = new URLSearchParams({ confirm: "yes" });
    for (const [field, value] of new FormData(form)) {
      if (typeof value === "string") {
        body.append(field, value);
      }
    }
    try {
      const response = await fetch(form.action, { method: "POST", body });
      if (response.ok) {
        message = `Deleted “${title}”.`;
        removed = true;
      } else if (response.status === 404) {
        // Deleted already, for example in another tab.
        message = `“${title}” was already deleted.`;
        removed = true;
      } else if (response.status === 401) {
        message = `Could not delete “${title}”, because you are signed out. Reload the page to sign in again.`;
      } else {
        message = `Could not delete “${title}”. Reload the page and try again.`;
      }
    } catch {
      message = `Could not delete “${title}”. Check your connection and try again.`;
    }
    setBusy(false);
    // Close the dialog and move focus first. VoiceOver does not speak a status message that is
    // written in the same task as the dialog closing, even after focus has moved (#56; plan,
    // "Deleting bookmarks"). So the message is written 500 ms later. 100 ms was enough until the
    // address form's empty status region came before the list heading (#105): with it,
    // VoiceOver read the heading that took focus and dropped a message written 100 ms after it
    // every time, and spoke one written 500 ms after it every time (plan, "Deleting
    // bookmarks"). If the dialog is opened again within those 500 ms, the page is inert again
    // before the message is written, so the message is lost. That is accepted because the user
    // would have to move to another Delete button and press it in that time.
    dialog.close();
    if (removed) {
      removeItem(item);
    }
    setTimeout(() => announce(message), ANNOUNCE_DELAY_MS);
  });

  // Closing returns focus to the Delete button that opened the dialog (a native <dialog>
  // does this). After a deletion, removeItem then moves focus on from the removed item.
  dialog.addEventListener("close", () => {
    pending = null;
  });
}
