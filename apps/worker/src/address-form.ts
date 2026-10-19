// The "Save a link" address form (#97): one field for a page's address. It posts the address to
// /save/address, which looks up the page's title and description and redirects to the save form
// with them (#105, save-address.ts), so saving itself does not change. See "Save flow" in
// plans/haystack-v1-implementation-plan.md.
//
// The saved links page shows the form at its top. GET /save shows it as a page of its own when
// the request carries no captured field, and both GET /save and POST /save/address show it again
// with an error when the checks reject the address.
//
// The lookup can take a few seconds, so address-form.js shows that Continue is waiting and stops
// a second submission. The form works without it.
//
// The form has `novalidate`, and the field is not `required`. The browser's own check would
// otherwise block the request with its own message, in its own bubble, before the server's error
// could explain the rule (only complete https:// links), so one field would have two kinds of
// error. Every error comes from the server instead, tied to the field. The field keeps
// `type="url"` for the keyboard and the autofill it offers.
import { html, type SafeHtml } from "./html.ts";
import { fieldError, SENSITIVE_NOTICE } from "./notices.ts";
import { htmlResponse } from "./page.ts";

/** What the form shows. */
export interface AddressFormState {
  /**
   * The address to put back in the field, as typed. Only a value that parses as a URL and that
   * the sensitive URL check does not flag in any reading of it (`rejectedAddress` in save.ts),
   * because the refusal never shows the link (plan, "Sensitive URLs").
   */
  readonly value: string;
  /** Why the address was rejected. */
  readonly error?: string;
}

const LABEL = "Save a link";
const FIELD_ID = "save-url";
const HINT_ID = "save-url-hint";
const ERROR_ID = "save-url-error";
// The card's label, which also names its form.
const TITLE_ID = "save-url-label";

// The status region, where address-form.js says that the page is being looked up. It is in the
// page from the start, empty, because a screen reader announces a change to a live region that
// already exists, as on the saved links page.
const STATUS_ID = "save-url-status";

/** The script that shows the pending state, which every page with the posting form loads. */
export const ADDRESS_FORM_SCRIPT = "/assets/address-form.js";

// The hint, the field, the button and the status, which both forms share. The field is described
// by the error first, then the hint, so the reason is heard first. The row and the status share a
// wrapper, so the empty status adds no gap to the form.
function controls({ value, error }: AddressFormState): SafeHtml {
  const describedBy = error === undefined ? HINT_ID : `${ERROR_ID} ${HINT_ID}`;
  const invalid = error === undefined ? null : html` aria-invalid="true"`;
  const typed = value === "" ? null : html` value="${value}"`;
  return html`<p id="${HINT_ID}" class="hint">Paste the address of a page. You confirm its title on the next step.</p>
        <div class="address-controls">
          <div class="address-row">
            <input id="${FIELD_ID}" class="address-input" name="url" type="url" autocomplete="url"${typed} aria-describedby="${describedBy}"${invalid}>
            <button class="button button-primary" type="submit">Continue</button>
          </div>
          <div id="${STATUS_ID}" class="status address-status" role="status"></div>
        </div>`;
}

// Signed in, the form posts to /save/address, which looks the page up. Before sign-in it asks for
// GET /save instead, because a POST without a session is refused like every other one, while GET
// /save sends the user through sign-in and back to the save form for the address.
function formTarget(signedIn: boolean): SafeHtml {
  return signedIn ? html`method="post" action="/save/address"` : html`method="get" action="/save"`;
}

/**
 * The form at the top of the saved links page, titled by its label, as the design shows it. It
 * comes before the page's heading, so a screen reader user who moves by heading would pass it.
 * Naming it after its label makes it a form landmark, "Save a link", which they can move to.
 * Only a signed-in user sees the saved links page.
 */
export function addressFormCard(): SafeHtml {
  return html`<form class="panel address-form" ${formTarget(true)} novalidate aria-labelledby="${TITLE_ID}">
        <label id="${TITLE_ID}" class="address-form-title" for="${FIELD_ID}">${LABEL}</label>
        ${controls({ value: "" })}
      </form>`;
}

/**
 * The form as a page of its own. The page asks one question, so its heading is the field's
 * label, as in the GOV.UK Design System's question pages, and the page reads like the save form
 * that follows it. An error is shown as the save form shows its own: in an alert after the
 * heading, with the field pointing at it. Focus is not moved, as on the save form.
 *
 * This form is not named, so it is not a landmark. The heading comes first in `<main>` and is
 * the field's label, so moving by heading or to the main landmark reaches the form, and a form
 * landmark named "Save a link" right after the heading "Save a link" would only repeat it.
 */
export function addressFormPage(state: AddressFormState, signedIn: boolean): Response {
  const error = state.error === undefined ? null : fieldError(ERROR_ID, state.error);
  return htmlResponse(
    state.error === undefined ? LABEL : "Check the address",
    html`<h1><label for="${FIELD_ID}">${LABEL}</label></h1>${error}
      <form class="panel address-form" ${formTarget(signedIn)} novalidate>
        ${controls(state)}
        ${SENSITIVE_NOTICE}
      </form>`,
    state.error === undefined ? 200 : 400,
    { signedIn, scripts: [ADDRESS_FORM_SCRIPT] },
  );
}
