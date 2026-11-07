// The search page at `/` (plan, "Search page", Phase 10). The Worker renders the form, the empty
// live region and the empty results list. search.js sends each search to /api/search with
// `fetch` and builds the results from the JSON answer with DOM APIs and `textContent`, so no
// bookmark data is ever parsed as markup. Searching needs that script, so until it runs the page
// says so and links to the saved links, which work without it.
import { SEARCH_QUERY_CAP } from "@haystack/schemas";
import { bookmarkCardTemplate } from "./bookmark-card.ts";
import { SAVED_LINKS_PATH } from "./bookmark-paths.ts";
import { html } from "./html.ts";
import { messageBar, type Outcome, SENSITIVE_NOTICE } from "./notices.ts";
import { htmlResponse } from "./page.ts";

/**
 * The page's one module script. It imports the delete dialog's module, so the page has one
 * `<script>` element (plan, "Search page", "Performance").
 */
export const SEARCH_SCRIPT = "/assets/search.js";

const FIELD_ID = "search-query";
const HINT_ID = "search-hint";
const LABEL = "Search your saved links";
// The message that searching needs the script, which the script hides when it runs. It is in the
// page rather than in a <noscript>, so it is also shown when the script is blocked or fails to
// load, which a <noscript> is not.
const NEEDS_SCRIPT_ID = "search-needs-script";
// The voice input's parts (#216), which voice-input.js finds by these IDs, and has its own copy
// of, because the assets can't import this.
const VOICE_BUTTON_ID = "voice-button";
const VOICE_STATUS_ID = "voice-status";
const VOICE_PRIVACY_ID = "voice-privacy";

/**
 * The voice button's icon, inline because the CSP allows no images: a microphone, and a stop
 * square that site.css shows instead while the button is pressed, so the listening state is not
 * color alone. Both are drawn in `currentColor`, so forced colors give them the button's text
 * color. The button's name says what it does, so the icon is hidden from assistive technology.
 */
const VOICE_ICON = html`<svg class="voice-icon" viewBox="0 0 24 24" aria-hidden="true">
                <g class="voice-icon-microphone" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"></rect>
                  <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"></path>
                </g>
                <rect class="voice-icon-stop" x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"></rect>
              </svg>`;

/**
 * The search page. The page asks one question, so its heading is the field's label, as on the
 * address form's own page. The field has no `name`: without JavaScript, pressing Search submits
 * the form with no fields, which only loads this page again, so the query never reaches a URL,
 * where the browser's history and Cloudflare's logs would keep it.
 *
 * The heading, the live region and the empty state have the IDs the saved links page and /held
 * give theirs, so that the delete dialog finds them (#208): focus moves to the heading when the
 * last result is deleted, the dialog writes its message to the search's live region, and it
 * shows the empty state, which search.js hides again with the next search's outcome. The live
 * region is in the page from the start, because a screen reader announces a change to a live
 * region that already exists. It is empty, or holds the result of a delete that returned here
 * (`outcome`). The results list is hidden until a search finds something, and so is its `h2`
 * (#245), which each result's `h3` title sits under. Once the delete dialog removes the last
 * result, the heading stays over the empty state, as on the saved links page. Each result is a
 * saved link's card, which search.js clones from the template at the end of the page (design
 * review).
 *
 * The voice input (#216) is in the page too, with `hidden`, so it is hidden from everyone until
 * voice-input.js shows it, which it does only when the browser has speech recognition: the
 * button, after the field, and the privacy note, which describes it, under the row. The voice
 * input's live region is between them, and stays hidden until the button's first press, so a
 * person who never presses it has one live region on the page.
 */
export function showSearchPage(outcome: Outcome | null = null): Response {
  const message = outcome === null ? null : html`<p>${outcome.message}</p>`;
  return htmlResponse(
    outcome === null ? "Search" : `${outcome.title} - Search`,
    html`<h1 id="list-heading"><label for="${FIELD_ID}">${LABEL}</label></h1>
      ${messageBar(
        html`<p id="${NEEDS_SCRIPT_ID}" class="callout">Searching needs JavaScript, which isn't running in this browser. <a href="${SAVED_LINKS_PATH}">Go to your saved links</a> to browse them instead.</p>`,
        html`<div id="list-status" class="status" role="status">${message}</div>`,
        SENSITIVE_NOTICE,
      )}
      <search>
        <form class="panel search-form" method="get" action="/" data-search-form>
          <p id="${HINT_ID}" class="hint">Describe what you're looking for in your own words.</p>
          <div class="search-row">
            <input id="${FIELD_ID}" class="search-input" type="search" maxlength="${SEARCH_QUERY_CAP}" aria-describedby="${HINT_ID}">
            <button id="${VOICE_BUTTON_ID}" class="button voice-button" type="button" aria-label="Search by voice" aria-pressed="false" aria-describedby="${VOICE_PRIVACY_ID}" hidden>
              ${VOICE_ICON}
            </button>
            <button class="button button-primary" type="submit">Search</button>
          </div>
          <div id="${VOICE_STATUS_ID}" class="status voice-status" role="status" hidden></div>
          <p id="${VOICE_PRIVACY_ID}" class="hint voice-privacy" hidden>In some browsers, including Chrome, searching by voice sends a recording of what you say to the browser maker's servers, which turn it into text.</p>
        </form>
      </search>
      <h2 id="results-heading" class="cards-heading" hidden>Results</h2>
      <ol id="search-results" class="cards" aria-labelledby="results-heading" hidden></ol>
      <p id="empty-state" class="empty-state" hidden>You deleted every link this search found. Search again to find others.</p>
      ${bookmarkCardTemplate()}`,
    200,
    { signedIn: true, width: "wide", current: "search", scripts: [SEARCH_SCRIPT] },
  );
}
