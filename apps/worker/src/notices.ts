// Text and messages that more than one page shows.
import { html, type SafeHtml } from "./html.ts";

// The save form's Save button refers to this paragraph by its id.
export const SENSITIVE_NOTICE = html`<p id="sensitive-notice" class="notice">
  Do not save links that contain access tokens, private shares, or sign-in and password reset
  links. Saved links are sent to the services that describe them, so a private link would no
  longer be private.
</p>`;

/**
 * The error for a rejected field, shown after the page's heading. The field's aria-describedby
 * points at the paragraph by `id`.
 *
 * The alert is on a wrapper, and the field points at the plain paragraph inside it. VoiceOver in
 * WebKit does not read a description from an element that has a live-region role itself. See
 * "Save flow" in plans/haystack-v1-implementation-plan.md.
 */
export function fieldError(id: string, message: string): SafeHtml {
  return html`<div class="alert" role="alert"><p id="${id}">${message}</p></div>`;
}
