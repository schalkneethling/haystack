// The enrichment sweep (#127): the one operation that enriches every outstanding bookmark, a few
// in each run. See "Enrichment sweep", "Enrichment state is derived, not stored" and Q3 in
// plans/haystack-v1-implementation-plan.md. The first backfill, a schema version change and the
// retries after failures on save all use it. The scheduled run (scheduled.ts, #128) is its
// caller, and reads the batch size from a Flagship flag and the attempt limit from a `var`.
//
// A run, in order:
// 1. Rewrites `match_text` for a few enrichments at an older derivation (match-text-refresh.ts),
//    which calls no service.
// 2. Selects Pending and Outdated bookmarks of every user, oldest first, up to the batch size,
//    leaving out any within its backoff window (selectBookmarksToEnrich).
// 3. Enriches them with enrichBookmark, up to `concurrency` at once.
// 4. Logs a summary of counts (SweepSummary), and resolves to it.
//
// It is idempotent: a run with nothing outstanding selects nothing and calls no service. It is
// resumable: the progress is the data itself, so what one run stores is what the next one
// selects from, and stopping at any point loses nothing.
//
// How a run stops. A rejected account (EnrichmentAccountError), an outage (OUTAGE_STOP_CALLS) and
// any other thrown error stop it the same way:
// - no bookmark that hasn't started is started;
// - the run's controller is aborted, so a bookmark already under way sends nothing more and
//   records no failure (EnrichmentRun in enrich-bookmark.ts), although an answer it already has,
//   its noul or its enrichment, is still stored, because it was paid for and is about the
//   bookmark. For a rejected account, enrichBookmark aborts it the moment the answer comes, so
//   the stop doesn't wait for the error to reach the sweep;
// - the error that stopped the run is logged once, by its code and fixed fields only;
// - every bookmark under way is awaited before the summary is logged, so the summary counts
//   what was stored, and no write is left running when the scheduled handler returns.
// A request already sent can't be called back, so a bookmark under way may still have one
// answered after the stop. The Jev client gets the run's signal too, so it makes no other
// attempt at that question and doesn't wait out its backoff (askJev).
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  type SQL,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Db } from "../db/client.ts";
import { bookmarks, enrichmentFailures, enrichments } from "../db/schema.ts";
import { errorCode } from "../error-code.ts";
import {
  type BookmarkToEnrich,
  ENRICHMENT_TIMING,
  EnrichmentAccountError,
  type EnrichmentConfig,
  type EnrichmentOutcome,
  type EnrichmentTiming,
  enrichBookmark,
} from "./enrich-bookmark.ts";
import { ENRICHMENT_SCHEMA_VERSION } from "./enrichment-schema.ts";
import { GitHubPause } from "./github-pause.ts";
import { refreshMatchText } from "./match-text-refresh.ts";
import { collectStateInputs } from "./state-inputs.ts";
import {
  BACKOFF_MAX_MS,
  backoffWindowMs,
  deriveEnrichmentState,
  readSensitiveWarnThreshold,
} from "./state.ts";

/**
 * The most bookmarks one run may enrich on Workers Free (Q3). Each makes at most 10 outside
 * requests and 3 D1 statements, and the run itself up to 8 D1 statements and 2 flag reads, so 3
 * bookmarks make at most 49 subrequests, under the limit of 50, and a 4th would make 62.
 * enrichPending refuses a larger batch, and the configuration module (flags.ts, #128) uses this
 * as the batch size flag's ceiling.
 */
export const SWEEP_BATCH_SIZE_LIMIT = 3;

/** The batch size when none is given: Q3's starting size, which is also its ceiling. */
export const SWEEP_BATCH_SIZE = 3;

/**
 * How many bookmarks are enriched at once when no number is given: the whole batch. Each
 * bookmark makes its requests one after another, so 3 at once hold at most 3 connections, and a
 * Worker's 7th simultaneous connection would wait for one of the 6 rather than fail (Q3).
 */
export const SWEEP_CONCURRENCY = 3;

/**
 * How many permanent failures, counting every 5th failure in a row as one
 * (TRANSIENT_FAILURES_PER_ATTEMPT), leave a bookmark Failed when no limit is given: the plan's
 * default of 3. The scheduled run (#128) reads the limit from SWEEP_ATTEMPT_LIMIT and passes it.
 */
export const DEFAULT_ATTEMPT_LIMIT = 3;

/**
 * A run stops when the first OUTAGE_STOP_CALLS bookmarks to finish all failed transiently,
 * because a provider outage affects every bookmark in the same way, and trying the rest would
 * only add to their failure counts. One transient failure isn't enough, because one bookmark's
 * request can time out or meet a 529 on its own, and the LLM's isn't retried. Two from different
 * bookmarks, with nothing that worked in between, look like the service. It must stay below Q3's
 * batch size of 3, or the stop could never spare a bookmark: at a batch of 3, it spares the
 * third. A smaller batch, which the batch size flag allows (#128), gets no early stop: at 2, the
 * run has nothing left to spare once both have failed, although its summary still says it
 * stopped for an outage, and at 1, the rule never applies, because the run ends after its one
 * bookmark.
 *
 * Those failures are recorded, as any failure is, so in an outage longer than about two and a
 * half days, the bookmarks each run tries first can reach Failed. The owner accepted that
 * (2026-10-25, #127), because recording them is what grows their backoff: otherwise two
 * bookmarks that always time out would stay at the front of the queue and stop every run.
 */
export const OUTAGE_STOP_CALLS = 2;

/** What a run may be given. Each has a default, so the scheduled handler passes only its own. */
export interface SweepOptions {
  // At most SWEEP_BATCH_SIZE_LIMIT.
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly attemptLimit?: number;
  // The clients' time limits. The tests shorten them.
  readonly timing?: EnrichmentTiming;
}

/** Why a run stopped before finishing its batch. */
export type SweepStop =
  // Its first OUTAGE_STOP_CALLS bookmarks all failed transiently.
  | "outage"
  // A service rejected Haystack's account (EnrichmentAccountError).
  | "account"
  // Any other thrown error, such as a configuration error or a D1 error.
  | "error";

/** What the run did, as counts, so it can be logged: never a URL, a title or an error message. */
export interface SweepSummary {
  // Bookmarks the run chose to enrich, at most the batch size.
  readonly selected: number;
  // Selected bookmarks that ended enriched, Held, or with a failure recorded.
  readonly enriched: number;
  readonly held: number;
  readonly failed: number;
  // Selected bookmarks the run didn't finish, because it stopped first.
  readonly unfinished: number;
  // Whether more Pending or Outdated bookmarks, outside their backoff window, were outstanding
  // than the batch held, so it is false once the backlog is drained. It isn't a count, because
  // the selection reads only one bookmark past the batch (selectBookmarksToEnrich). Bookmarks
  // within their window aren't counted at all: the selection leaves them out in SQL, and a count
  // of them would mean reading every outstanding bookmark again, which is what bounding the
  // selection avoids. Each has its failure record, and the earlier runs' summaries counted it.
  readonly moreOutstanding: boolean;
  // Enrichments whose `match_text` was rewritten, and those left as they were because their
  // stored data couldn't be read (match-text-refresh.ts).
  readonly refreshed: number;
  readonly unreadable: number;
  // Whether GitHub rate-limited a request, so that the rest of the run asked it nothing.
  readonly githubPaused: boolean;
  readonly stopped: SweepStop | null;
}

/** What the selection is given. */
export interface SelectionPolicy {
  readonly batchSize: number;
  readonly attemptLimit: number;
  readonly sensitiveWarnThreshold: number;
  // The time the backoff windows are measured against, in epoch milliseconds.
  readonly now: number;
}

/** The bookmarks one run enriches, and whether more are outstanding. */
export interface Selection {
  readonly bookmarks: readonly BookmarkToEnrich[];
  readonly moreOutstanding: boolean;
}

// The count of failures in a row from which the window is BACKOFF_MAX_MS, found from
// backoffWindowMs itself, so the SQL below can't cap it at another count.
const BACKOFF_CAPPED_FROM = (() => {
  let failures = 1;
  while (backoffWindowMs(failures) < BACKOFF_MAX_MS) {
    failures += 1;
  }
  return failures;
})();

/**
 * backoffWindowMs as SQL, for the selection's WHERE clause: one value for each count below
 * BACKOFF_CAPPED_FROM, each taken from backoffWindowMs, and the cap from there on. The selection
 * applies the backoff in SQL so that its bound (selectBookmarksToEnrich) never fills with
 * bookmarks that are waiting. A test checks that the two agree at every count. A NULL count,
 * which a bookmark without a failure record has, gives 0, as backoffWindowMs does for no
 * failures, so the window doesn't depend on the caller checking for NULL first.
 */
export function backoffWindowSql(consecutiveFailures: SQLWrapper): SQL {
  const counts = Array.from({ length: BACKOFF_CAPPED_FROM - 1 }, (_, index) => index + 1);
  const none = sql`${consecutiveFailures} IS NULL OR ${consecutiveFailures} < 1`;
  return sql`(CASE WHEN ${none} THEN 0 ${sql.join(
    counts.map(
      (failures) =>
        sql`WHEN ${consecutiveFailures} = ${failures} THEN ${backoffWindowMs(failures)}`,
    ),
    sql` `,
  )} ELSE ${BACKOFF_MAX_MS} END)`;
}

/**
 * The Pending and Outdated bookmarks of every user, oldest first, up to the batch size, leaving
 * out those within their backoff window, in one statement.
 *
 * A subquery picks the candidates' ids, oldest first, and reads at most one more than the batch
 * size, so a run reads the text of at most that many bookmarks however large the backlog is,
 * after a schema version change too, and the extra one says whether more are outstanding. So
 * that the bound never fills with bookmarks the run would leave out, the subquery applies every
 * condition: no enrichment at the current version, a failure record below the attempt limit,
 * not Held (isHeld), and outside the backoff window (backoffWindowSql). A Held bookmark stays
 * Held until someone reviews it, so leaving that to the code below could let Held bookmarks take
 * every place. The outer query reads the candidates' rows as readEnrichmentStateInputs reads one
 * user's, and deriveEnrichmentState, through collectStateInputs, still decides which are
 * Pending or Outdated, so the sweep and the /held page can't derive the state differently. A test
 * checks that the two agree for a bookmark in every state.
 */
export async function selectBookmarksToEnrich(
  db: Db,
  { batchSize, attemptLimit, sensitiveWarnThreshold, now }: SelectionPolicy,
): Promise<Selection> {
  const candidate = alias(bookmarks, "candidates");
  const candidateFailure = alias(enrichmentFailures, "candidate_failures");
  const current = alias(enrichments, "current_enrichments");
  const backoffWindow = backoffWindowSql(candidateFailure.consecutiveFailures);
  const candidates = db
    .select({ id: candidate.id })
    .from(candidate)
    .leftJoin(
      candidateFailure,
      and(
        eq(candidateFailure.bookmarkId, candidate.id),
        eq(candidateFailure.schemaVersion, ENRICHMENT_SCHEMA_VERSION),
      ),
    )
    .where(
      and(
        notExists(
          db
            .select({ id: current.id })
            .from(current)
            .where(
              and(
                eq(current.bookmarkId, candidate.id),
                eq(current.schemaVersion, ENRICHMENT_SCHEMA_VERSION),
              ),
            ),
        ),
        or(isNull(candidateFailure.attempts), lt(candidateFailure.attempts, attemptLimit)),
        or(
          isNull(candidate.sensitivityNoul),
          lt(candidate.sensitivityNoul, sensitiveWarnThreshold),
          isNotNull(candidate.sensitivityAcknowledgedAt),
        ),
        or(
          isNull(candidateFailure.lastAttemptAt),
          lte(sql`${candidateFailure.lastAttemptAt} + ${backoffWindow}`, now),
        ),
      ),
    )
    .orderBy(asc(candidate.createdAt), asc(candidate.id))
    .limit(batchSize + 1);

  // One row per enrichment, or one for a bookmark with none, as readEnrichmentStateInputs reads
  // them. A bookmark has at most one failure record per version, so that join adds no rows.
  const rows = await db
    .select({
      bookmarkId: bookmarks.id,
      sensitivityNoul: bookmarks.sensitivityNoul,
      sensitivityAcknowledgedAt: bookmarks.sensitivityAcknowledgedAt,
      enrichmentVersion: enrichments.schemaVersion,
      failedAttempts: enrichmentFailures.attempts,
      // The rest of BookmarkToEnrich, which enrichBookmark reads, so it reads no row itself.
      id: bookmarks.id,
      url: bookmarks.url,
      title: bookmarks.title,
      description: bookmarks.description,
      canonicalUrl: bookmarks.canonicalUrl,
      capturedTitle: bookmarks.capturedTitle,
      capturedDescription: bookmarks.capturedDescription,
      ogTitle: bookmarks.ogTitle,
      ogDescription: bookmarks.ogDescription,
      ogSiteName: bookmarks.ogSiteName,
      sensitiveCanonicalDropped: bookmarks.sensitiveCanonicalDropped,
    })
    .from(bookmarks)
    .leftJoin(enrichments, eq(enrichments.bookmarkId, bookmarks.id))
    .leftJoin(
      enrichmentFailures,
      and(
        eq(enrichmentFailures.bookmarkId, bookmarks.id),
        eq(enrichmentFailures.schemaVersion, ENRICHMENT_SCHEMA_VERSION),
      ),
    )
    .where(inArray(bookmarks.id, candidates))
    .orderBy(asc(bookmarks.createdAt), asc(bookmarks.id), asc(enrichments.schemaVersion));

  const policy = { schemaVersion: ENRICHMENT_SCHEMA_VERSION, sensitiveWarnThreshold, attemptLimit };
  const outstanding = collectStateInputs(rows, ENRICHMENT_SCHEMA_VERSION).filter((inputs) => {
    const state = deriveEnrichmentState(inputs, policy);
    return state === "pending" || state === "outdated";
  });
  return {
    bookmarks: outstanding.slice(0, batchSize),
    moreOutstanding: outstanding.length > batchSize,
  };
}

// A whole number from `min` to `max`, or a bug in the caller, which throws before anything runs.
function checkedCount(name: string, value: number, min: number, max = Infinity): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Infinity ? `from ${min}` : `from ${min} to ${max}`;
    throw new RangeError(`${name} is ${value}, which isn't a whole number ${range}`);
  }
  return value;
}

// Logs a thrown error by what is safe to log: an account error's fixed fields, and any other
// error's code or name (error-code.ts), never a message.
function logError(error: unknown): void {
  if (error instanceof EnrichmentAccountError) {
    const { code, step, reason, status } = error;
    console.error("Enrichment sweep error:", { code, step, reason, status });
  } else {
    console.error("Enrichment sweep error:", { code: errorCode(error) });
  }
}

/**
 * Runs one sweep: the `match_text` refresh, then up to `batchSize` outstanding bookmarks, oldest
 * first, `concurrency` at a time. Logs the summary and resolves to it. A thrown error stops the
 * run, is logged without its message, and is in the summary as `stopped`, so the scheduled
 * handler can go on with its cleanup. Throws only for options that aren't whole numbers in range,
 * which are a bug in the caller.
 */
export async function enrichPending(
  db: Db,
  config: EnrichmentConfig,
  options: SweepOptions = {},
): Promise<SweepSummary> {
  const batchSize = checkedCount(
    "batchSize",
    options.batchSize ?? SWEEP_BATCH_SIZE,
    1,
    SWEEP_BATCH_SIZE_LIMIT,
  );
  const concurrency = checkedCount("concurrency", options.concurrency ?? SWEEP_CONCURRENCY, 1);
  const attemptLimit = checkedCount(
    "attemptLimit",
    options.attemptLimit ?? DEFAULT_ATTEMPT_LIMIT,
    1,
  );
  const timing = options.timing ?? ENRICHMENT_TIMING;

  const counts = { enriched: 0, held: 0, failed: 0, refreshed: 0, unreadable: 0 };
  let selection: Selection = { bookmarks: [], moreOutstanding: false };
  let stopped: SweepStop | null = null;
  const github = new GitHubPause();
  // The run's signal is aborted with what stopped it: the error that was thrown, or an outage's
  // own reason. enrichBookmark aborts it too, with the EnrichmentAccountError, the moment a
  // service rejects the account (EnrichmentRun).
  const controller = new AbortController();
  const stop = (why: SweepStop, reason: unknown) => {
    if (stopped === null) {
      stopped = why;
      controller.abort(reason);
    }
  };

  // The outage rule looks at the first OUTAGE_STOP_CALLS bookmarks to finish, in the order they
  // finish, because with several under way that is the order the run learns of them.
  let finished = 0;
  let allTransient = true;
  const count = (outcome: EnrichmentOutcome) => {
    counts[outcome.outcome] += 1;
    finished += 1;
    if (finished <= OUTAGE_STOP_CALLS) {
      allTransient &&= outcome.outcome === "failed" && outcome.failure === "transient";
      if (finished === OUTAGE_STOP_CALLS && allTransient) {
        stop("outage", new Error("The enrichment sweep's first calls all failed transiently"));
      }
    }
  };
  const enrichOne = async (bookmark: BookmarkToEnrich) => {
    try {
      count(await enrichBookmark(db, config, bookmark, timing, { controller, github }));
    } catch (error) {
      // What stopped the run reaches here from every bookmark under way, because each of the
      // others throws the signal's reason at its next step. It is logged the first time only, and
      // those bookmarks are only unfinished.
      if (stopped !== null && error === controller.signal.reason) {
        return;
      }
      logError(error);
      stop(error instanceof EnrichmentAccountError ? "account" : "error", error);
    }
  };

  try {
    ({ refreshed: counts.refreshed, unreadable: counts.unreadable } = await refreshMatchText(db));
    selection = await selectBookmarksToEnrich(db, {
      batchSize,
      attemptLimit,
      sensitiveWarnThreshold: readSensitiveWarnThreshold(config),
      now: Date.now(),
    });
    // Each worker takes the next bookmark that hasn't started until none is left or the run has
    // stopped, so no more than `concurrency` are under way at once. enrichOne never rejects.
    const queue = [...selection.bookmarks];
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (controller.signal.aborted) {
          return;
        }
        await enrichOne(next);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  } catch (error) {
    // The refresh or the selection: a D1 error, or a threshold that can't be read.
    logError(error);
    stop("error", error);
  }

  const selected = selection.bookmarks.length;
  const summary: SweepSummary = {
    selected,
    enriched: counts.enriched,
    held: counts.held,
    failed: counts.failed,
    unfinished: selected - counts.enriched - counts.held - counts.failed,
    moreOutstanding: selection.moreOutstanding,
    refreshed: counts.refreshed,
    unreadable: counts.unreadable,
    githubPaused: github.paused,
    stopped,
  };
  console.info("Enrichment sweep:", summary);
  return summary;
}
