// What a search takes and what the search page gets back. See "Search page" and "Question
// design" in plans/haystack-v1-implementation-plan.md.
import * as v from "valibot";

/**
 * The longest query any channel may send, in UTF-16 code units (String.prototype.length). The
 * query is repeated in the state of every Jev request a search makes, so a long one costs every
 * chunk, and agents can send long queries (Milestone 4). The search page's field has it as its
 * `maxlength`, so the page and the server agree.
 */
export const SEARCH_QUERY_CAP = 500;

/**
 * The shared search input: the query every channel sends, trimmed, and between 1 and
 * SEARCH_QUERY_CAP characters long. `searchBookmarks` validates its query with it (#212).
 */
export const SearchQuery = v.pipe(
  v.string(),
  v.trim(),
  v.nonEmpty("Enter a query"),
  v.maxLength(SEARCH_QUERY_CAP, `Must be at most ${SEARCH_QUERY_CAP} characters`),
);

/**
 * A bookmark's ID, as the search page puts it into the IDs of a result's elements, which the
 * Delete control's `aria-labelledby` refers to (#208). An IDREF list is split on whitespace, so
 * an ID must be non-empty and hold none. Bookmark IDs come from `crypto.randomUUID()`, whose
 * hexadecimal digits and hyphens this allows. search.js checks the same pattern.
 */
const RESULT_ID = /^[\w-]+$/;

/**
 * The latest time a JavaScript `Date` can hold, in milliseconds since the epoch. The search page
 * formats `createdAt` as a date, and a `Date` past it is invalid, so formatting would throw.
 * search.js checks the same bound.
 */
const LATEST_DATE = 8.64e15;

/**
 * One result as the search page shows it, in the saved links page's card (design review): the
 * bookmark's confirmed title and description, its address, when it was saved, and its ID, which
 * the page's Delete control (#208) and the result's own element need. The page links the title
 * to the address only when it is an https address (`isHttpsUrl`).
 */
export const SearchResult = v.object({
  id: v.pipe(v.string(), v.regex(RESULT_ID, "Must be letters, digits, underscores or hyphens")),
  title: v.string(),
  description: v.nullable(v.string()),
  url: v.string(),
  /** When the bookmark was saved, in milliseconds since the epoch: `bookmarks.created_at`. */
  createdAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(LATEST_DATE)),
});

/**
 * Whether every bookmark was searched. `ok` when Jev answered for every candidate, and `partial`
 * when some of the chunks failed, so the results come from the chunks that succeeded, and the
 * page says they may be incomplete (plan, "When Jev fails"). They are the names of the run's
 * outcome in the log (#212). A search whose every chunk failed, the `failed` outcome, has no
 * answer of this shape: `/api/search` answers it with an error status (#214), so the page shows
 * the error state, and can never show it as an empty list.
 */
const SearchOutcome = v.picklist(["ok", "partial"]);

/**
 * The web answer of `/api/search`, in ranked order. It is the search page's own shape, with the
 * IDs the page needs: the bookmark's in each result, and the run's, which recording a followed
 * result uses (#215), and whether the results may be incomplete. The Milestone 4 tool returns a
 * narrower result (title, description, URL and kind), which is a schema of its own.
 */
export const SearchAnswer = v.object({
  runId: v.string(),
  outcome: SearchOutcome,
  results: v.array(SearchResult),
});

export type SearchAnswer = v.InferOutput<typeof SearchAnswer>;
