// Asking Jev about a collection of any size (#211). See "Jev model limits", "Request modes" and
// "When Jev fails" in plans/haystack-v1-implementation-plan.md.
//
// The collection is split into chunks that fit Jev's two token budgets by the estimate
// (search-chunks.ts), and the chunks are sent at once, up to SEARCH_JEV_CONCURRENCY in flight,
// each attempt waiting its turn at the limiter (jev-limiter.ts). Each chunk is askSearch's request,
// with its retries (SEARCH_TIMING, #210).
//
// A chunk that Jev still finds too long, a `400` with `max_tokens_exceeded`, is split in half, and
// each half is asked on its own, and split again while it is still too long. A `413` is only a
// body over 32 MiB, which a chunk inside 64k tokens can't reach, so it fails like any other
// permanent status. A response that leaves out or malforms an answer isn't split either: its size
// isn't the problem, and #210 found that the same request would most likely get the same answer.
//
// Any other chunk that fails after its attempts is recorded as failed, and the answers of the
// chunks that succeeded are kept, so the caller can show them and log the run as `partial`. When
// every chunk fails, there are no answers, and the outcome is `failed`, never an empty `ok`.
//
// A signal ends the search, as #212's deadline does. A chunk that has sent nothing by then is
// recorded as failed with the reason `aborted`, and the chunks already answered are kept, so a
// search cut short is `partial`, not lost. A chunk whose attempt is under way runs to its answer
// or its time limit, because the client doesn't give the signal to `fetch`.
//
// Pair mode (#213, pair-search.ts) is this same search with one request for each bookmark instead
// of one for each chunk: searchInRequests takes how the bookmarks are grouped into requests, and
// everything after that, the limiter, the concurrency limit, the signal, the failures and the
// shape of the result, is shared, so the two modes can't drift apart.
//
// Nothing here reads the database or ranks the answers (#212).
import type { searchRuns } from "../db/schema.ts";
import type { JevConfig, JevFailure, JevTiming } from "../enrichment/jev-client.ts";
import { concurrencyLimit, SEARCH_JEV_CONCURRENCY } from "./concurrency.ts";
import { ISOLATE_JEV_LIMITER, type JevLimiter } from "./jev-limiter.ts";
import {
  askSearch,
  type BookmarkAnswers,
  SEARCH_TIMING,
  type SearchAsk,
  type SearchBookmark,
} from "./jev-search.ts";
import { chunkBookmarks, estimateSearchRequest } from "./search-chunks.ts";

/** Whether every bookmark was answered: the `search_runs.outcome` column. */
export type SearchOutcome = (typeof searchRuns.$inferSelect)["outcome"];

/**
 * A request that was never sent, because the search's signal was aborted before its first attempt.
 * Its reason is a fixed value, safe to log.
 */
export interface SearchRequestAborted {
  readonly ok: false;
  readonly reason: "aborted";
  readonly attempts: 0;
}

/**
 * A request that failed after its attempts, or was never sent, and the bookmarks it asked about.
 */
export interface SearchRequestFailure {
  // In the order the caller gave them.
  readonly bookmarkIds: readonly string[];
  // Its reason, class, status and code are fixed values, safe to log.
  readonly failure: JevFailure | SearchRequestAborted;
}

/** What a search of a whole collection got from Jev. */
export interface SearchRequestsResult {
  /**
   * `ok` when every bookmark was answered, an empty collection included; `partial` when some
   * were; `failed` when a collection of at least one bookmark got no answer at all.
   */
  readonly outcome: SearchOutcome;
  /** Each answered bookmark's answers, in the order the caller gave the bookmarks. */
  readonly answers: readonly BookmarkAnswers[];
  /** The ID of every bookmark that has no answer, in the order the caller gave them. */
  readonly unanswered: readonly string[];
  /** Each request that failed, in the order of its bookmarks. A split request isn't one. */
  readonly failures: readonly SearchRequestFailure[];
  /**
   * Each model that answered, as the responses name it, once each, in the order of the requests
   * whose responses first name it, not the order the responses arrived in.
   */
  readonly models: readonly string[];
  /** The sum of `usage.input_tokens` over the responses that answered. */
  readonly inputTokens: number;
  /** How many requests were sent, every retry and every request that was split included. */
  readonly attempts: number;
}

export interface SearchRequestsOptions {
  /** The limiter every attempt waits on. The isolate's, which all of search shares, by default. */
  readonly limiter?: JevLimiter;
  /** Each request's attempts. SEARCH_TIMING by default. */
  readonly timing?: JevTiming;
  /**
   * Ends the search: askJevQuestions' `signal`, given to every request. A request not yet sent when
   * it is aborted is a failure with the reason `aborted`, and the search still resolves.
   */
  readonly signal?: AbortSignal;
}

// What became of one chunk, or of the halves it was split into.
interface ChunkOutcome {
  readonly answers: readonly BookmarkAnswers[];
  readonly failures: readonly SearchRequestFailure[];
  readonly models: readonly string[];
  readonly inputTokens: number;
  readonly attempts: number;
}

/**
 * Asks Jev about every bookmark of `ask`, in as many requests as its size needs, and returns
 * what it answered, which bookmarks it didn't, and what that cost. An empty collection sends
 * nothing. Rejects with searchRequestParts' RangeError for a bookmark ID given twice, with
 * chunkBookmarks' for a bookmark that fits no request, and with the client's configuration errors,
 * before anything is sent. An aborted `signal` doesn't reject it: the chunks not yet sent are
 * failures with the reason `aborted`.
 */
export function searchInChunks(
  config: JevConfig,
  ask: SearchAsk,
  options: SearchRequestsOptions = {},
): Promise<SearchRequestsResult> {
  return searchInRequests(config, ask, chunkBookmarks, options);
}

/**
 * The search that both request modes are: asks about the bookmarks of `ask` in the requests that
 * `group` makes of them, in the order of the bookmarks, each request waiting its turn at the
 * limiter, under the concurrency limit. A request that Jev finds too long is split in half, and
 * one bookmark can't be split further. What it rejects with is searchInChunks', and `group`'s own
 * errors, after the check for a bookmark given twice.
 */
export async function searchInRequests(
  config: JevConfig,
  ask: SearchAsk,
  group: (ask: SearchAsk) => readonly (readonly SearchBookmark[])[],
  { limiter = ISOLATE_JEV_LIMITER, timing = SEARCH_TIMING, signal }: SearchRequestsOptions = {},
): Promise<SearchRequestsResult> {
  if (new Set(ask.bookmarks.map(({ id }) => id)).size !== ask.bookmarks.length) {
    throw new RangeError("A search request names a bookmark more than once");
  }
  const chunks = group(ask);
  const inFlight = concurrencyLimit(SEARCH_JEV_CONCURRENCY);

  const askChunk = async (bookmarks: readonly SearchBookmark[]): Promise<ChunkOutcome> => {
    const chunk: SearchAsk = { query: ask.query, bookmarks, questions: ask.questions };
    const gate = limiter.gate(estimateSearchRequest(chunk).requestTokens);
    let result;
    try {
      result = await inFlight(() => askSearch(config, chunk, timing, signal, gate));
    } catch (error) {
      // The client throws the signal's reason when it is aborted before the first attempt. The
      // reason is the caller's, so it isn't kept, and the chunk is a failure like any other.
      if (signal?.aborted !== true || error !== signal.reason) {
        throw error;
      }
      const aborted: SearchRequestAborted = { ok: false, reason: "aborted", attempts: 0 };
      return {
        answers: [],
        failures: [{ bookmarkIds: bookmarks.map(({ id }) => id), failure: aborted }],
        models: [],
        inputTokens: 0,
        attempts: 0,
      };
    }
    if (result.ok) {
      return {
        answers: result.answer,
        failures: [],
        models: [result.model],
        inputTokens: result.inputTokens,
        attempts: result.attempts,
      };
    }
    if (result.code === "max_tokens_exceeded" && bookmarks.length > 1) {
      const middle = Math.ceil(bookmarks.length / 2);
      const halves = await Promise.all([
        askChunk(bookmarks.slice(0, middle)),
        askChunk(bookmarks.slice(middle)),
      ]);
      const combined = combine(halves);
      return { ...combined, attempts: combined.attempts + result.attempts };
    }
    return {
      answers: [],
      failures: [{ bookmarkIds: bookmarks.map(({ id }) => id), failure: result }],
      models: [],
      inputTokens: 0,
      attempts: result.attempts,
    };
  };

  const { answers, failures, models, inputTokens, attempts } = combine(
    await Promise.all(chunks.map(askChunk)),
  );
  const unanswered = failures.flatMap(({ bookmarkIds }) => bookmarkIds);
  return {
    outcome: unanswered.length === 0 ? "ok" : answers.length === 0 ? "failed" : "partial",
    answers,
    unanswered,
    failures,
    models,
    inputTokens,
    attempts,
  };
}

// The outcomes of consecutive chunks as one, in their order.
function combine(outcomes: readonly ChunkOutcome[]): ChunkOutcome {
  return {
    answers: outcomes.flatMap(({ answers }) => answers),
    failures: outcomes.flatMap(({ failures }) => failures),
    models: [...new Set(outcomes.flatMap(({ models }) => models))],
    inputTokens: outcomes.reduce((sum, { inputTokens }) => sum + inputTokens, 0),
    attempts: outcomes.reduce((sum, { attempts }) => sum + attempts, 0),
  };
}
