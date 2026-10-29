// @ts-check
// Searches the saved links from the search page at `/` (plan, "Search page"). The Worker renders
// the form, an empty live region and an empty results list, and this script does the rest: it
// sends the query to /api/search with `fetch`, and builds each result from the JSON answer with
// DOM APIs and `textContent`, so no bookmark data is ever parsed as markup. Searching needs this
// script. Until it runs, the page says so and links to the saved links, and the script hides that
// message.
//
// - Focus stays where it was, in the field after Enter or on the button after a press, so a
//   person can change the query and search again straight away, and Tab moves on to the button
//   and then to the first result. Nothing on the page takes focus.
// - The live region says how many links matched, or that none did. That is announced, because
//   the region is in the page from the start, and it is not focused, so a screen reader that
//   reads a focused live region twice reads it once.
// - A newer search replaces one still waiting for its answer, and the late answer is ignored, so
//   the results and the count are always the newest query's. How a slow search looks, a search
//   that took too long, aborting the replaced request and a second press with the same query
//   come with #207.
//
// The page's one script, so it imports the delete dialog's module (plan, "Search page",
// "Performance"). The dialog wires the Delete forms that are in the page when it loads, which
// on this page is none, until the results get their Delete control (#208).
import "./delete-dialog.js";

const FORM = "form[data-search-form]";
const FIELD_ID = "search-query";
const RESULTS_ID = "search-results";
const NEEDS_SCRIPT_ID = "search-needs-script";
// The page's one live region, which the delete dialog finds by the same ID (#208).
const STATUS_ID = "list-status";

/** The route that searches (#214). It answers 404 until then, which the page calls a failure. */
const SEARCH_PATH = "/api/search";

// Each message is written ANNOUNCE_DELAY_MS after the change that comes with it, here the new
// results, as the site's other scripts do (address-form.js, delete-dialog.js), because VoiceOver
// has dropped messages written in the same task as a change to the page. At 100 ms, the address
// form's delay, VoiceOver never spoke the count on CI (run 40849016780, twice). 500 ms is the
// delete dialog's, the delay at which VoiceOver spoke its message after the page changed (plan,
// "Deleting bookmarks"), but it didn't speak the count at 500 ms either (run 40854364804), and
// making it speak the count is #237. The messages are kept here, so they are easy to change.
const ANNOUNCE_DELAY_MS = 500;
const MESSAGES = {
  empty: "Type what you're looking for, then press Search.",
  none: "No saved links match your search.",
  /** @param {number} count */
  found: (count) =>
    count === 1 ? "1 saved link matches your search." : `${count} saved links match your search.`,
  failed:
    "Something went wrong, so your links could not be searched. You can press Search to try again.",
  signedOut: "You are signed out, so your links could not be searched.",
  signIn: "Sign in again",
};

/**
 * @typedef {{ id: string, title: string, description: string | null, url: string }} Result
 * @typedef {{ kind: "found", results: Result[] } | { kind: "failed" | "signedOut" }} Outcome
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

// A result's ID goes into its elements' IDs, which the Delete control's `aria-labelledby` refers
// to (#208), so it must be non-empty and hold no whitespace: the pattern of `SearchResult.id`.
const RESULT_ID = /^[\w-]+$/;

/**
 * The results in a success answer, in its order, or null when the answer doesn't have the shape
 * of `SearchAnswer` in packages/schemas. The assets have no build step, so the page can't import
 * that schema. It checks the fields it reads instead, and the browser tests build every answer
 * they give with the schema, so the two can't drift apart unnoticed.
 * @param {unknown} body
 * @returns {Result[] | null}
 */
function resultsIn(body) {
  if (!isRecord(body) || typeof body.runId !== "string" || !Array.isArray(body.results)) {
    return null;
  }
  /** @type {Result[]} */
  const results = [];
  for (const result of body.results) {
    if (
      !isRecord(result) ||
      typeof result.id !== "string" ||
      !RESULT_ID.test(result.id) ||
      typeof result.title !== "string" ||
      typeof result.url !== "string" ||
      !(result.description === null || typeof result.description === "string")
    ) {
      return null;
    }
    const { id, title, description, url } = result;
    results.push({ id, title, description, url });
  }
  return results;
}

// The rule of `isHttpsUrl` in packages/schemas, which the saved links page links by: an https
// address exactly as the URL parser reads it, with an explicit `https://` and no spaces or
// control characters. Escaping does not make an address safe, so anything else is not a link.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const CHARACTERS_THE_PARSER_CHANGES = /[\u0000-\u0020\u007f]/;
const HTTPS_PREFIX = /^https:\/\//i;

/** @param {string} value */
function isHttpsAddress(value) {
  if (CHARACTERS_THE_PARSER_CHANGES.test(value) || !HTTPS_PREFIX.test(value)) {
    return false;
  }
  // The URL constructor, not URL.canParse, which Safari before 17 does not have.
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

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

/**
 * A result's card: the title as a heading that wraps the link, then the description, with its
 * line breaks kept, as the saved links page shows them. The IDs are the saved links page's, so
 * the Delete control (#208) is named by the title and the dialog finds the item.
 * @param {Result} result
 */
function resultItem({ id, title, description, url }) {
  const item = element("li");
  item.id = `bookmark-${id}`;
  const article = element("article");
  article.className = "result";
  const heading = element("h2");
  heading.id = `title-${id}`;
  if (isHttpsAddress(url)) {
    const link = /** @type {HTMLAnchorElement} */ (element("a", title));
    link.href = url;
    // The saved site isn't told that the visit came from Haystack.
    link.rel = "noreferrer";
    heading.append(link);
  } else {
    heading.textContent = title;
  }
  article.append(heading);
  if (description !== null && description !== "") {
    const paragraph = element("p");
    paragraph.className = "card-description";
    for (const [index, line] of description.split("\n").entries()) {
      if (index > 0) {
        paragraph.append(element("br"));
      }
      paragraph.append(line);
    }
    article.append(paragraph);
  }
  item.append(article);
  return item;
}

/**
 * Sends the query and says what the answer means.
 * @param {string} query
 * @returns {Promise<Outcome>}
 */
async function search(query) {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(SEARCH_PATH, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
  } catch {
    return { kind: "failed" };
  }
  if (response.status === 401) {
    return { kind: "signedOut" };
  }
  const isJson = (response.headers.get("content-type") ?? "").startsWith("application/json");
  if (response.status !== 200 || !isJson) {
    return { kind: "failed" };
  }
  const results = resultsIn(await response.json().catch(() => null));
  return results === null ? { kind: "failed" } : { kind: "found", results };
}

/**
 * @param {HTMLFormElement} form
 * @param {HTMLInputElement} field
 * @param {HTMLOListElement} list
 * @param {HTMLElement} status
 */
function enhance(form, field, list, status) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let announcement;
  // The search whose answer the page is waiting for. A newer search replaces it, so a late answer
  // to a replaced query is ignored, and never shows its results under the newer query. Aborting
  // the replaced request, and ignoring a second press with the same query, come with #207.
  /** @type {{ query: string } | null} */
  let inFlight = null;

  /**
   * Writes a message to the live region after the delay. A message still waiting is dropped, so
   * only the newest is written.
   * @param {...(string | Node)} content
   */
  function announce(...content) {
    clearTimeout(announcement);
    announcement = setTimeout(() => {
      const paragraph = element("p");
      paragraph.append(...content);
      status.replaceChildren(paragraph);
    }, ANNOUNCE_DELAY_MS);
  }

  /** @param {Result[]} results */
  function show(results) {
    list.replaceChildren(...results.map(resultItem));
    list.hidden = results.length === 0;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // The last message goes, so the next one is a change to the region even when its words are
    // the same, such as the same count twice, and a screen reader announces it.
    clearTimeout(announcement);
    status.replaceChildren();
    const query = field.value.trim();
    if (query === "") {
      // The query was replaced with nothing, so an answer to the one before is not wanted either.
      inFlight = null;
      announce(MESSAGES.empty);
      return;
    }
    const request = { query };
    inFlight = request;
    const outcome = await search(query);
    if (inFlight !== request) {
      return;
    }
    inFlight = null;
    if (outcome.kind === "found") {
      show(outcome.results);
      announce(
        outcome.results.length === 0 ? MESSAGES.none : MESSAGES.found(outcome.results.length),
      );
      return;
    }
    // Results from an earlier query would read as this query's, so they go.
    show([]);
    if (outcome.kind === "signedOut") {
      // Sign-in comes back to this page.
      const signIn = /** @type {HTMLAnchorElement} */ (element("a", MESSAGES.signIn));
      signIn.href = `/auth/sign-in?return_to=${encodeURIComponent(window.location.pathname)}`;
      announce(`${MESSAGES.signedOut} `, signIn);
    } else {
      announce(MESSAGES.failed);
    }
  });
}

const form = document.querySelector(FORM);
const field = document.getElementById(FIELD_ID);
const list = document.getElementById(RESULTS_ID);
const status = document.getElementById(STATUS_ID);
if (
  form instanceof HTMLFormElement &&
  field instanceof HTMLInputElement &&
  list instanceof HTMLOListElement &&
  status !== null
) {
  enhance(form, field, list, status);
  document.getElementById(NEEDS_SCRIPT_ID)?.setAttribute("hidden", "");
}
