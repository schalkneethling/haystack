// The search service (#212): the one function that every search surface calls, the search page's
// `/api/search` (#214), WebMCP and MCP (Milestone 4) and Phase 12's evaluation runs, so they all
// get the same candidates, ranking, thresholds and logging (decision 19). See "Search design",
// "Ranking and thresholds" and "Data model" in plans/haystack-v1-implementation-plan.md.
//
// It takes plain values and no request object: the user, the query, where the search came from,
// and, as explicit arguments, the database, the Jev configuration, the search settings that the
// caller read from Flagship once for this search (readSearchSettings in flags.ts) and the policy
// that decides which bookmarks are Held. It
// 1. rejects a query outside the shared schema's bounds, and pair mode until #213 builds it,
//    before anything is read, sent or logged;
// 2. reads the candidates (search-candidates.ts);
// 3. asks Jev about them in batched mode (searchInChunks, #211), ending at SEARCH_DEADLINE_MS;
// 4. ranks the answers by the display signal (search-ranking.ts);
// 5. logs the run and every answer (search-log.ts), whatever the outcome;
// 6. returns the outcome, the run's ID and the shown results.
//
// The query never leaves this module except in the Jev request's state and the run's `query`
// column. The `error` column and the log line hold fixed codes, statuses and counts only, and a
// rejection's message is fixed text, so none of them can carry the query, a response body or the
// key.
import { SEARCH_QUERY_CAP, type SearchAnswer, SearchQuery } from "@haystack/schemas";
import * as v from "valibot";
import type { Db } from "../db/client.ts";
import type { searchRuns } from "../db/schema.ts";
import { assertJevConfig, type JevConfig, type JevTiming } from "../enrichment/jev-client.ts";
import type { EnrichmentStatePolicy } from "../enrichment/state.ts";
import type { SearchSettings } from "../flags.ts";
import {
  type ChunkedSearchResult,
  type SearchChunkFailure,
  type SearchOutcome,
  searchInChunks,
} from "./chunked-search.ts";
import {
  ISOLATE_JEV_LIMITER,
  type JevLimiter,
  type LimiterClock,
  SYSTEM_CLOCK,
} from "./jev-limiter.ts";
import { SEARCH_TIMING } from "./jev-search.ts";
import { readSearchCandidates, type SearchCandidate } from "./search-candidates.ts";
import { writeSearchLog } from "./search-log.ts";
import { rankAnswers, signalMatches, usedSearchSettings } from "./search-ranking.ts";

type SearchRun = typeof searchRuns.$inferSelect;

/** Where a search came from: the `search_runs.channel` column. */
export type SearchChannel = SearchRun["channel"];

/** How a web search's query was entered: the `search_runs.input_mode` column. */
export type SearchInputMode = NonNullable<SearchRun["inputMode"]>;

/** The channel, with the input mode, which only the web channel has. */
export type SearchSource =
  | { readonly channel: "web"; readonly inputMode: SearchInputMode }
  | { readonly channel: Exclude<SearchChannel, "web">; readonly inputMode?: undefined };

/** What a search runs with, other than its own inputs. */
export interface SearchContext {
  readonly db: Db;
  readonly jev: JevConfig;
  /** The settings read once for this search, which the run records as it used them. */
  readonly settings: SearchSettings;
  /** Which bookmarks are Held: readReviewPolicy's (held.ts), from SENSITIVE_WARN_THRESHOLD. */
  readonly policy: EnrichmentStatePolicy;
  /** The limiter every request waits on. The isolate's by default. */
  readonly limiter?: JevLimiter;
  /** Each request's attempts. SEARCH_TIMING by default. */
  readonly timing?: JevTiming;
  /** The clock the deadline and the latency are measured on. The Worker's by default. */
  readonly clock?: LimiterClock;
}

/** One shown result, in the search page's own shape (`SearchAnswer` in @haystack/schemas). */
export type SearchResult = SearchAnswer["results"][number];

/** What a search returns. */
export interface SearchBookmarksResult {
  /** The `search_runs` row's ID, which recording a followed result needs (#215). */
  readonly runId: string;
  /**
   * `ok`, `partial` when some candidates went unanswered, so the results may be incomplete, or
   * `failed` when none was answered. A failed search has no results, and the caller shows an
   * error state rather than an empty list (plan, "When Jev fails").
   */
  readonly outcome: SearchOutcome;
  /** The shown results, best first. */
  readonly results: readonly SearchResult[];
}

/**
 * What a search leaves unused of the page's 30 seconds (`TIMEOUT_MS` in search.js) after its
 * deadline and the attempt that may still be under way then: the time to write the log, send the
 * response and cross the network, and the time before the service starts, reading the session and
 * the flags.
 */
export const SEARCH_RESPONSE_MARGIN_MS = 5_000;

/**
 * How long after it starts a search stops asking Jev: 20 seconds, the page's 30 less an attempt's
 * time limit (SEARCH_TIMING's 5 seconds) and SEARCH_RESPONSE_MARGIN_MS. At the deadline, a chunk
 * waiting on the limiter, a backoff or a connection sends nothing, and a split chunk's halves are
 * not sent, so each is unanswered, and the search is `partial`, or `failed` when nothing was
 * answered. An attempt already under way runs to its answer or its time limit, because the client
 * doesn't give the signal to `fetch` (#211), so the search can ask Jev for up to 25 seconds. A
 * search of one chunk, as the production collection is, ends in 16.5 seconds at worst without a
 * `Retry-After`, so only a search of several chunks, a split chunk or a long `Retry-After` reaches
 * the deadline (plan, "Jev client").
 */
export const SEARCH_DEADLINE_MS = 20_000;

/** Why a search was refused before anything was read, sent or logged. */
export type SearchRejection = "SEARCH_QUERY_INVALID" | "SEARCH_REQUEST_MODE_UNSUPPORTED";

/**
 * A search refused before anything was read, sent or logged. Its `code` is safe to log, and its
 * message is fixed text that never holds the query.
 */
export class SearchRejectedError extends Error {
  readonly code: SearchRejection;

  constructor(code: SearchRejection, message: string) {
    super(message);
    this.name = "SearchRejectedError";
    this.code = code;
  }
}

// The reason a search's deadline aborts its signal with. searchInChunks recognises it as the
// signal's own reason, and records the chunks not yet sent as `aborted`.
class SearchDeadlineError extends Error {
  constructor() {
    super("The search's deadline passed");
    this.name = "SearchDeadlineError";
  }
}

/**
 * The run's `error`: each failed request's reason, with its status when it had one, as
 * `status:503`, once each, in the order of the requests' bookmarks, joined by commas. A reason
 * and a status are fixed values (JevFailure), as `last_error`'s are (#126). Null when nothing
 * failed.
 */
function runError(failures: readonly SearchChunkFailure[]): string | null {
  const codes = failures.map(({ failure }) =>
    "status" in failure && failure.status !== undefined
      ? `${failure.reason}:${failure.status}`
      : failure.reason,
  );
  return codes.length === 0 ? null : [...new Set(codes)].join(",");
}

// Asks Jev about the candidates until the deadline. The deadline's timer stops when the search
// does, so a finished search leaves nothing waiting on the clock.
async function askUntilDeadline(
  jev: JevConfig,
  query: string,
  candidates: readonly SearchCandidate[],
  settings: SearchSettings,
  { limiter, timing, clock }: Required<Pick<SearchContext, "limiter" | "timing" | "clock">>,
): Promise<ChunkedSearchResult> {
  const deadline = new AbortController();
  const finished = new AbortController();
  void clock.sleep(SEARCH_DEADLINE_MS, finished.signal).then(() => {
    if (!finished.signal.aborted) {
      deadline.abort(new SearchDeadlineError());
    }
  });
  try {
    return await searchInChunks(
      jev,
      {
        query,
        bookmarks: candidates.map(({ id, title, kind, matchText }) => ({
          id,
          title,
          kind,
          matchText,
        })),
        questions: settings.questions,
      },
      { limiter, timing, signal: deadline.signal },
    );
  } finally {
    finished.abort();
  }
}

/**
 * Searches the user's bookmarks for `query`, logs the run and every answer, and returns the
 * outcome, the run's ID and the shown results.
 *
 * Throws a SearchRejectedError, having read, sent and logged nothing, for a query that the
 * shared schema refuses (empty once trimmed, or longer than SEARCH_QUERY_CAP once trimmed) and
 * for the `pair` request mode, which #213 adds. Throws the client's configuration errors, such as
 * TYPESAFE_API_KEY_EMPTY, the same way. A Jev failure doesn't throw: it is the `partial` or
 * `failed` outcome, logged like any other. An error from the database does throw.
 *
 * The query is sent to Jev trimmed, as the schema returns it, and logged exactly as it was given,
 * because Phase 12 joins its runs to its labeled queries by the exact text (#204).
 */
export async function searchBookmarks(
  userId: string,
  query: string,
  source: SearchSource,
  {
    db,
    jev,
    settings,
    policy,
    limiter = ISOLATE_JEV_LIMITER,
    timing = SEARCH_TIMING,
    clock = SYSTEM_CLOCK,
  }: SearchContext,
): Promise<SearchBookmarksResult> {
  const parsed = v.safeParse(SearchQuery, query);
  if (!parsed.success) {
    throw new SearchRejectedError(
      "SEARCH_QUERY_INVALID",
      `A search query must have 1 to ${SEARCH_QUERY_CAP} characters, not counting the spaces around it`,
    );
  }
  if (settings.requestMode === "pair") {
    throw new SearchRejectedError(
      "SEARCH_REQUEST_MODE_UNSUPPORTED",
      "The pair request mode isn't built yet (#213), so search runs only in batched mode",
    );
  }
  assertJevConfig(jev);
  const used = usedSearchSettings(settings);
  const started = clock.now();

  const candidates = await readSearchCandidates(db, userId, policy);
  const asked = await askUntilDeadline(jev, parsed.output, candidates, used, {
    limiter,
    timing,
    clock,
  });
  const latencyMs = clock.now() - started;

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const shown = rankAnswers(asked.answers, used, (id) => byId.get(id)?.createdAt ?? 0);
  const shownIds = new Set(shown);
  const error = runError(asked.failures);
  const runId = await writeSearchLog(
    db,
    {
      userId,
      query,
      channel: source.channel,
      inputMode: source.channel === "web" ? source.inputMode : null,
      requestMode: used.requestMode,
      // The model that answered; the configured one when nothing was answered. Every request asks
      // the configured model, so a search has one answering model, unless TypeSafe moved an alias
      // between its chunks, and then the first chunk's is recorded.
      jevModel: asked.models[0] ?? jev.JEV_MODEL,
      questions: used.questions,
      displaySignal: used.displaySignal,
      noulThreshold: used.noulThreshold,
      scoreThreshold: used.scoreThreshold,
      inputTokens: asked.inputTokens,
      latencyMs,
      outcome: asked.outcome,
      error,
    },
    asked.answers.map(({ bookmarkId, noul, score }) => ({
      bookmarkId,
      noul,
      score,
      shown: shownIds.has(bookmarkId),
    })),
  );

  // Counts and codes only. The other signal's list is counted here, and a replay rebuilds it from
  // the answers and the run's thresholds.
  const otherSignal = used.displaySignal === "noul" ? "score" : "noul";
  console.info("Search:", {
    channel: source.channel,
    outcome: asked.outcome,
    candidates: candidates.length,
    answered: asked.answers.length,
    shown: shown.length,
    otherSignalMatches:
      used.questions === "both" ? signalMatches(asked.answers, used, otherSignal).length : null,
    attempts: asked.attempts,
    latencyMs,
    error,
  });

  return {
    runId,
    outcome: asked.outcome,
    results: shown.flatMap((id) => {
      const candidate = byId.get(id);
      return candidate === undefined
        ? []
        : [
            {
              id: candidate.id,
              title: candidate.title,
              description: candidate.description,
              url: candidate.url,
              createdAt: candidate.createdAt,
            },
          ];
    }),
  };
}
