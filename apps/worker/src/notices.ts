// Text that more than one page shows.
import { html } from "./html.ts";

// The save form's Save button refers to this paragraph by its id.
export const SENSITIVE_NOTICE = html`<p id="sensitive-notice">
  Do not save links that contain access tokens, private shares, or sign-in and password reset
  links. Saved links are sent to the services that describe them, so a private link would no
  longer be private.
</p>`;
