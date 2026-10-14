// @ts-check
// Confirms deletion on the recent saves list in a modal dialog, and deletes in place. Without
// this script, each Delete button leads to a confirmation page instead (plan, "Deleting
// bookmarks"). The server renders every other part of the page.

const list = document.getElementById("recent-saves");
const heading = document.getElementById("list-heading");
const status = document.getElementById("list-status");
const emptyState = document.getElementById("empty-state");

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
  const title = element("h2", "Delete this link?");
  title.id = "delete-dialog-heading";
  const name = element("p");
  name.id = "delete-dialog-name";
  const notice = element("p", "Deleting is permanent. You can save the link again later.");
  notice.id = "delete-dialog-notice";
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
  const cancel = /** @type {HTMLButtonElement} */ (element("button", "Cancel"));
  cancel.type = "button";
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
 * Focus moves to the next item's title heading, then the previous item's, then the list
 * heading. A heading is named by its text, so a screen reader reads the title on focus.
 * @param {Element} item
 */
function removeItem(item) {
  const neighbour = item.nextElementSibling ?? item.previousElementSibling;
  const target = neighbour?.querySelector("h2") ?? heading;
  item.remove();
  if (list !== null && list.children.length === 0) {
    list.remove();
    emptyState?.removeAttribute("hidden");
  }
  if (target instanceof HTMLElement) {
    target.tabIndex = -1;
    target.focus();
  }
}

if (list !== null && typeof HTMLDialogElement === "function") {
  const { dialog, name, confirm, cancel } = createDialog();
  list.after(dialog);

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

  list.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    event.preventDefault();
    if (busy) {
      return;
    }
    pending = form;
    const title = form.closest("li")?.querySelector("h2")?.textContent ?? "";
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
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: new URLSearchParams({ confirm: "yes" }),
      });
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
    // Announce before focus moves, so the message is not cut off by what focus reads.
    announce(message);
    dialog.close();
    if (removed) {
      removeItem(item);
    }
  });

  // Closing returns focus to the Delete button that opened the dialog (a native <dialog>
  // does this). After a deletion, removeItem then moves focus on from the removed item.
  dialog.addEventListener("close", () => {
    pending = null;
  });
}
