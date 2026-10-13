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
  dialog.setAttribute("aria-labelledby", "delete-dialog-heading");
  const title = element("h2", "Delete this link?");
  title.id = "delete-dialog-heading";
  const name = element("p");
  const notice = element("p", "Deleting is permanent. You can save the link again later.");
  const confirm = /** @type {HTMLButtonElement} */ (element("button", "Delete"));
  confirm.type = "button";
  const cancel = /** @type {HTMLButtonElement} */ (element("button", "Cancel"));
  cancel.type = "button";
  // Cancel is focused when the dialog opens, so Enter does not delete by accident.
  cancel.autofocus = true;
  dialog.append(title, name, notice, confirm, cancel);
  cancel.addEventListener("click", () => dialog.close());
  return { dialog, name, confirm };
}

/** @param {string} message */
function announce(message) {
  if (status !== null) {
    status.replaceChildren(element("p", message));
  }
}

/**
 * Focus moves to the next item, then the previous one, then the list heading.
 * @param {Element} item
 */
function removeItem(item) {
  const target = item.nextElementSibling ?? item.previousElementSibling ?? heading;
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
  const { dialog, name, confirm } = createDialog();
  list.after(dialog);

  /** @type {HTMLFormElement | null} */
  let pending = null;

  list.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    event.preventDefault();
    pending = form;
    const title = form.closest("li")?.querySelector("h2")?.textContent ?? "";
    name.textContent = title;
    dialog.showModal();
  });

  confirm.addEventListener("click", async () => {
    const form = pending;
    const item = form?.closest("li");
    if (form === null || item === null || item === undefined) {
      return;
    }
    const title = name.textContent ?? "";
    confirm.disabled = true;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: new URLSearchParams({ confirm: "yes" }),
      });
      dialog.close();
      if (response.ok) {
        removeItem(item);
        announce(`Deleted “${title}”.`);
      } else if (response.status === 404) {
        // Deleted already, for example in another tab.
        removeItem(item);
        announce(`“${title}” was already deleted.`);
      } else {
        announce(`Could not delete “${title}”. Reload the page and try again.`);
      }
    } catch {
      dialog.close();
      announce(`Could not delete “${title}”. Check your connection and try again.`);
    } finally {
      confirm.disabled = false;
    }
  });

  // Closing returns focus to the Delete button that opened the dialog (a native <dialog>
  // does this). After a deletion, removeItem then moves focus on from the removed item.
  dialog.addEventListener("close", () => {
    pending = null;
  });
}
