// The popup's entry: the only module that reads the build's origin or touches the page. It
// opens the save form and closes, or shows why the page can't be saved.
import { openSaveForm } from "./open-save-form.ts";

declare const __HAYSTACK_ORIGIN__: string;

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`The popup has no #${id}`);
  }
  return found;
}

const outcome = await openSaveForm(browser, __HAYSTACK_ORIGIN__);
if (outcome.opened) {
  window.close();
} else {
  element("popup-heading").textContent = outcome.heading;
  element("popup-message").textContent = outcome.message;
}
