// The confirmation that a link doesn't give access to anything private, which two forms ask for:
// Release on /held (#129), and the save form when Jev's check warns that the link might be
// private (#132). See "Probabilistic check with Jev" in plans/haystack-v1-implementation-plan.md.
// Both ask it in the same words and send it in the same field, so the confirmation means the same
// thing wherever the owner gives it.
import { html, type SafeHtml } from "./html.ts";

/** The checkbox's label, which an answer that didn't get the confirmation quotes. */
export const NOT_PRIVATE_LABEL = "This link does not give access to anything private";

const NOT_PRIVATE_FIELD = "not_private";
const NOT_PRIVATE_VALUE = "yes";

export interface NotPrivateCheckbox {
  readonly id: string;
  // The IDs that describe the checkbox, in the order a screen reader reads them.
  readonly describedBy: string;
  // Ticked, when a form comes back for another reason after the owner ticked it.
  readonly checked?: boolean;
  // Set when the form came back because the box wasn't ticked.
  readonly invalid?: boolean;
}

/**
 * The checkbox and its label, drawn by site.css (`.checkbox`). It is required, so the browser
 * asks for it before the form is sent, with or without JavaScript, and the server checks it again
 * (`isNotPrivateConfirmed`), because a request built by hand can leave it out.
 */
export function notPrivateCheckbox({
  id,
  describedBy,
  checked = false,
  invalid = false,
}: NotPrivateCheckbox): SafeHtml {
  return html`<div class="checkbox">
              <input type="checkbox" id="${id}" name="${NOT_PRIVATE_FIELD}" value="${NOT_PRIVATE_VALUE}"${checked ? html` checked` : null} required${invalid ? html` aria-invalid="true"` : null} aria-describedby="${describedBy}">
              <label for="${id}">${NOT_PRIVATE_LABEL}</label>
            </div>`;
}

/** Whether the submitted form has the box ticked. Any other value is not a confirmation. */
export function isNotPrivateConfirmed(form: FormData): boolean {
  return form.get(NOT_PRIVATE_FIELD) === NOT_PRIVATE_VALUE;
}
