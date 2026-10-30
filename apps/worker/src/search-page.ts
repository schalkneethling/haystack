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

/**
 * The search page. The page asks one question, so its heading is the field's label, as on the
 * address form's own page. The field has no `name`: without JavaScript, pressing Search submits
 * the form with no fields, which only loads this page again, so the query never reaches a URL,
 * where the browser's history and Cloudflare's logs would keep it.
 *
 * The heading, the live region and the empty state have the IDs the saved links page and /held
 * give theirs, so that the delete dialog finds them (#208): focus moves to the heading when the
 * last result is deleted, the dialog writes its message to the page's one live region, and it
 * shows the empty state, which search.js hides again with the next search's outcome. The live
 * region is in the page from the start, because a screen reader announces a change to a live
 * region that already exists. It is empty, or holds the result of a delete that returned here
 * (`outcome`). The results list is hidden until a search finds something, and so is its `h2`
 * (#245), which each result's `h3` title sits under. Once the delete dialog removes the last
 * result, the heading stays over the empty state, as on the saved links page. Each result is a
 * saved link's card, which search.js clones from the template at the end of the page (design
 * review).
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
            <button class="button button-primary" type="submit">Search</button>
          </div>
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
