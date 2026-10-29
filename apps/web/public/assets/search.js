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
//   and then to the first result. Nothing on the page takes focus, so a failure never takes it
//   from a person typing in the field. The one exception is Try again, which removes itself, so
//   it hands focus to the Search button, where a search is pressed.
// - The live region says what the search found, or that it is still running, or why it failed.
//   That is announced, because the region is in the page from the start, and it is not focused,
//   so a screen reader that reads a focused live region twice reads it once.
// - While a search runs (#207), the button's label says so, and it is never disabled, with
//   `disabled` or `aria-disabled`, as on the address form (address-form.js): it keeps focus, a
//   screen reader does not call it dimmed, and a second press is handled here instead. The same
//   query is ignored. A changed one aborts the request in flight and replaces it, and an answer
//   to the replaced request is ignored, so the results and the message are always the newest
//   query's.
// - Results that may be incomplete, because some of the collection could not be searched, are
//   shown with a notice that says so. A search that failed shows an error state with Try again in
//   place of the results, never an empty list, which would read as "nothing matches".
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

/** The Search button's label while a search runs: the address form's word for the same state. */
const PROCESSING_LABEL = "Processing…";

// Each message is written ANNOUNCE_DELAY_MS after the change that comes with it, here the new
// results or the button's new label, as the site's other scripts do (address-form.js,
// delete-dialog.js), because VoiceOver has dropped messages written in the same task as a change
// to the page. At 100 ms, the address form's delay, VoiceOver never spoke the count on CI (run
// 40849016780, twice). 500 ms is the delete dialog's, the delay at which VoiceOver spoke its
// message after the page changed (plan, "Deleting bookmarks"), but it didn't speak the count at
// 500 ms either (run 40854364804), and making it speak the page's messages is #237. A search
// that answers within the delay never shows the processing message, because the answer's
// message replaces it before it is written. The messages are kept here, so they are easy to
// change.
const ANNOUNCE_DELAY_MS = 500;
const MESSAGES = {
  empty: "Type what you're looking for, then press Search.",
  processing: "Searching your saved links. This can take a few seconds.",
  none: "No saved links match your search.",
  /** @param {number} count */
  found: (count) =>
    count === 1 ? "1 saved link matches your search." : `${count} saved links match your search.`,
  // When some of the collection could not be searched. "None" is not "No saved links match",
  // because a link that was not searched may match.
  noneSearched: "None of the links that could be searched match your search.",
  incomplete:
    "Some of your links could not be searched, so there may be more matches. You can press Search to try again.",
  timeout: "Searching your saved links took too long.",
  network: "Haystack could not be reached. Check your connection, then try again.",
  failed: "Something went wrong, so your links could not be searched.",
  tryAgain: "Try again",
  signedOut: "You are signed out, so your links could not be searched.",
  signIn: "Sign in again",
};

// How long the page waits for an answer. It is the ceiling that the search's whole budget must
// fit under: every chunk, its retries, the waits of the client-side limiter and the halves of a
// chunk that was split and retried (#212, plan, "Jev model limits" and "Jev client"). If Phase 11
// lets a search run longer, this changes with it. A search the page abandons here keeps running
// on the Worker, unless the route passes its request's signal on (#214). The timer is an ordinary
// setTimeout that aborts the request, as on the address form, rather than AbortSignal.timeout, so
// that one AbortController ends the request either way, and a test's clock can reach it.
const TIMEOUT_MS = 30_000;

/**
 * @typedef {{ id: string, title: string, description: string | null, url: string }} Result
 * @typedef {{ kind: "found", results: Result[], complete: boolean }
 *   | { kind: "timeout" | "network" | "failed" | "signedOut" }} Outcome
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

// A result's ID goes into its elements' IDs, which the Delete control's `aria-labelledby` refers
// to (#208), so it must be non-empty and hold no whitespace: the pattern of `SearchResult.id`.
const RESULT_ID = /^[\w-]+$/;

// The outcomes of `SearchAnswer`. A search whose every chunk failed is not an answer of that
// shape: the route answers it with an error status (#214).
const OUTCOMES = ["ok", "partial"];

/**
 * The results in a success answer, in its order, and whether every link was searched, or null
 * when the answer doesn't have the shape of `SearchAnswer` in packages/schemas. The assets have
 * no build step, so the page can't import that schema. It checks the fields it reads instead,
 * and the browser tests build every answer they give with the schema, so the two can't drift
 * apart unnoticed.
 * @param {unknown} body
 * @returns {{ results: Result[], complete: boolean } | null}
 */
function answerIn(body) {
  if (
    !isRecord(body) ||
    typeof body.runId !== "string" ||
    typeof body.outcome !== "string" ||
    !OUTCOMES.includes(body.outcome) ||
    !Array.isArray(body.results)
  ) {
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
  return { results, complete: body.outcome === "ok" };
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
 * A message's paragraph, which the status region draws in its raised box.
 * @param {...(string | Node)} content
 */
function paragraphOf(...content) {
  const paragraph = element("p");
  paragraph.append(...content);
  return paragraph;
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
 * What an answer means. An abort while the body is read, by the timeout or by a newer search, is
 * thrown on, so the caller tells it from an answer of the wrong shape.
 * @param {Response} response
 * @param {AbortSignal} signal
 * @returns {Promise<Outcome>}
 */
async function outcomeOf(response, signal) {
  if (response.status === 401) {
    return { kind: "signedOut" };
  }
  const isJson = (response.headers.get("content-type") ?? "").startsWith("application/json");
  if (response.status !== 200 || !isJson) {
    return { kind: "failed" };
  }
  const body = await response.json().catch((error) => {
    if (signal.aborted) {
      throw error;
    }
    return null;
  });
  const answer = answerIn(body);
  return answer === null ? { kind: "failed" } : { kind: "found", ...answer };
}

/**
 * @param {HTMLFormElement} form
 * @param {HTMLInputElement} field
 * @param {HTMLButtonElement} button
 * @param {HTMLOListElement} list
 * @param {HTMLElement} status
 */
function enhance(form, field, button, list, status) {
  const idleLabel = button.textContent ?? "";
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let announcement;
  // The search whose answer the page is waiting for. A newer search aborts and replaces it, and
  // an answer to a replaced search is ignored, so it never shows its results under the newer
  // query: an answer already on its way when the abort comes can still reach the script.
  /** @type {{ query: string, controller: AbortController } | null} */
  let inFlight = null;

  /**
   * Writes a message to the live region after the delay, in place of the one there. A message
   * still waiting is dropped, so only the newest is written.
   * @param {HTMLElement} message
   */
  function announce(message) {
    clearTimeout(announcement);
    announcement = setTimeout(() => {
      status.replaceChildren(message);
    }, ANNOUNCE_DELAY_MS);
  }

  // Empties the live region at once, so the next message is a change to the region even when its
  // words are the same, such as the same count twice, and a screen reader announces it.
  function clearMessage() {
    clearTimeout(announcement);
    status.replaceChildren();
  }

  /** @param {Result[]} results */
  function show(results) {
    list.replaceChildren(...results.map(resultItem));
    list.hidden = results.length === 0;
  }

  /**
   * The error state, which replaces the results: the alert's box, with what went wrong and Try
   * again, which sends the same query again. It is in the live region, so it is announced, and the
   * page has one live region (#208).
   * @param {string} text
   * @param {string} query The query that failed.
   */
  function failure(text, query) {
    const alert = element("div");
    alert.className = "alert";
    const body = element("div");
    body.className = "search-failure-body";
    const retry = /** @type {HTMLButtonElement} */ (element("button", MESSAGES.tryAgain));
    retry.type = "button";
    retry.className = "button button-primary button-small";
    retry.addEventListener("click", () => {
      // The query that failed goes back in the field, so the field always holds the query whose
      // results the page shows. Focus moves to the Search button before the search empties the
      // region, so it does not fall to the page with Try again. The form is then submitted, so
      // the search goes through the submit handler's rules, as a press of Search does.
      field.value = query;
      button.focus();
      form.requestSubmit();
    });
    body.append(paragraphOf(text), retry);
    alert.append(body);
    return alert;
  }

  /**
   * @param {Outcome} outcome
   * @param {string} query The query that was sent.
   */
  function settle(outcome, query) {
    if (outcome.kind === "found") {
      const { results, complete } = outcome;
      show(results);
      if (complete) {
        announce(
          paragraphOf(results.length === 0 ? MESSAGES.none : MESSAGES.found(results.length)),
        );
        return;
      }
      const notice = paragraphOf(
        results.length === 0 ? MESSAGES.noneSearched : MESSAGES.found(results.length),
        " ",
        MESSAGES.incomplete,
      );
      notice.className = "search-incomplete";
      announce(notice);
      return;
    }
    // Results from an earlier query would read as this query's, so they go.
    show([]);
    if (outcome.kind === "signedOut") {
      // Sign-in comes back to this page. Trying again would only be signed out again.
      const signIn = /** @type {HTMLAnchorElement} */ (element("a", MESSAGES.signIn));
      signIn.href = `/auth/sign-in?return_to=${encodeURIComponent(window.location.pathname)}`;
      announce(paragraphOf(`${MESSAGES.signedOut} `, signIn));
      return;
    }
    announce(failure(MESSAGES[outcome.kind], query));
  }

  /** @param {string} query */
  async function send(query) {
    const controller = new AbortController();
    const request = { query, controller };
    inFlight = request;
    button.textContent = PROCESSING_LABEL;
    clearMessage();
    announce(paragraphOf(MESSAGES.processing));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    /** @type {Outcome} */
    let outcome;
    try {
      const response = await fetch(SEARCH_PATH, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });
      outcome = await outcomeOf(response, controller.signal);
    } catch {
      outcome = { kind: timedOut ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
    // A search that a newer one replaced, or that a restored page dropped, says nothing.
    if (inFlight !== request) {
      return;
    }
    inFlight = null;
    button.textContent = idleLabel;
    settle(outcome, query);
  }

  // Ends the search in flight, if there is one, and gives the button its own label back.
  function stop() {
    inFlight?.controller.abort();
    inFlight = null;
    button.textContent = idleLabel;
  }

  // A press of Search or Enter in the field submits the form. The browser's own submission is
  // stopped, and the query that is already being searched for is not sent again.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = field.value.trim();
    if (query !== "" && inFlight?.query === query) {
      return;
    }
    stop();
    if (query === "") {
      // The query was replaced with nothing, so an answer to the one before is not wanted either.
      clearMessage();
      announce(paragraphOf(MESSAGES.empty));
      return;
    }
    void send(query);
  });

  // Following a result and coming back can restore this page from the back-forward cache as it
  // was left. A message still waiting to be written, such as a count whose results came just
  // before the person left, belongs to that moment, so it is dropped whether or not a search was
  // running: written after the restore, it would be announced as if something had just happened.
  // A search still running is dropped too, with its message, and the page says nothing.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) {
      return;
    }
    clearTimeout(announcement);
    if (inFlight !== null) {
      stop();
      clearMessage();
    }
  });
}

const form = document.querySelector(FORM);
const field = document.getElementById(FIELD_ID);
const button = form?.querySelector('button[type="submit"]');
const list = document.getElementById(RESULTS_ID);
const status = document.getElementById(STATUS_ID);
if (
  form instanceof HTMLFormElement &&
  field instanceof HTMLInputElement &&
  button instanceof HTMLButtonElement &&
  list instanceof HTMLOListElement &&
  status !== null
) {
  enhance(form, field, button, list, status);
  document.getElementById(NEEDS_SCRIPT_ID)?.setAttribute("hidden", "");
}
