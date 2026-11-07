// Pair mode (#213): one Jev request for each bookmark, with the query and that one bookmark in the
// state. It matches the TypeSafe re-ranking cookbook and is the quality reference that Phase 12
// compares batched mode with. See "Request modes" in plans/haystack-v1-implementation-plan.md.
//
// It is searchInChunks with a different grouping, so it shares everything else with it
// (chunked-search.ts): the questions and their wording and the response validation (jev-search.ts),
// the limiter and the concurrency limit, the retries, the signal that ends a search, and the shape
// of the result, so that the search service doesn't care which mode ran. Pair mode is the mode that
// meets the requests-per-second limit, because it sends one request for each bookmark, and the
// shared limiter spreads those requests over time.
//
// A bookmark is never split: the longest allowed bookmark with the longest query fits one request
// (search-chunks.ts), so a request that Jev still finds too long fails like any other permanent
// status, and its bookmark is unanswered. A bookmark that fits no request at all is refused before
// anything is sent, as in batched mode.
import type { JevConfig } from "../enrichment/jev-client.ts";
import {
  type SearchRequestsOptions,
  type SearchRequestsResult,
  searchInRequests,
} from "./chunked-search.ts";
import type { SearchAsk, SearchBookmark } from "./jev-search.ts";
import { chunkBookmarks } from "./search-chunks.ts";

/**
 * Asks Jev about each bookmark of `ask` in a request of its own, and returns what searchInChunks
 * returns: the answers in the order given, the bookmarks it didn't answer and why, the models
 * that answered, the summed `usage.input_tokens` and the number of requests sent. An empty
 * collection sends nothing. Rejects as searchInChunks does, for a bookmark ID given twice, a
 * bookmark that fits no request and the client's configuration errors, before anything is sent, and an aborted `signal` leaves the
 * bookmarks not yet sent unanswered with the reason `aborted`, as it leaves a chunk in batched mode.
 */
export function searchInPairs(
  config: JevConfig,
  ask: SearchAsk,
  options: SearchRequestsOptions = {},
): Promise<SearchRequestsResult> {
  return searchInRequests(config, ask, groupInPairs, options);
}

// One request for each bookmark. Each goes through chunkBookmarks, as batched mode's do, so a
// bookmark that fits no request throws the same RangeError before anything is sent, instead of
// being sent and refused.
function groupInPairs({ bookmarks, ...ask }: SearchAsk): SearchBookmark[][] {
  return bookmarks.flatMap((bookmark) => chunkBookmarks({ ...ask, bookmarks: [bookmark] }));
}
