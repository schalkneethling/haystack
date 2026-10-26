// The enrichment module (#126): one bookmark, from the sensitivity gate to its stored enrichment.
// See "Enrichment design", "Enrichment state is derived, not stored", "Enrichment sweep",
// "Probabilistic check with Jev" and Q3 in plans/haystack-v1-implementation-plan.md. It takes the
// bookmark's row and returns an outcome, and it knows nothing about how it was called, so the
// sweep (#127) and the on-save path (#133) call the same code. In production, the scheduled run
// (#128) calls the sweep. The on-save path comes with #133.
//
// The steps, in order:
// 1. The sensitivity gate, only when the bookmark's `sensitivity_noul` is empty. Jev is sent
//    describeUrlForJudgment's description, never the URL, and the noul is stored with the time.
//    A bookmark at or above SENSITIVE_WARN_THRESHOLD without an acknowledgment is Held: the
//    module stops, nothing about it goes to GitHub, the `kind` question or the LLM, and no
//    failure is recorded, because Held isn't a failed attempt.
// 2. GitHub, when the bookmark is a GitHub repository or a page within one. A GitHub failure
//    never fails the bookmark: the bookmark is enriched from what it captured. A 401 is the
//    exception, below.
// 3. The `kind` question, with the same evidence the LLM gets. The canonical URL is in it only as
//    describeUrlForJudgment's description (#157).
// 4. The LLM, through the provider ENRICHMENT_PROVIDER names, with writeProseEnrichment's
//    validation and its one retry.
// 5. `match_text` (match-text.ts).
// 6. The write: the enrichment, and the removal of its failure record, in one D1 batch.
//
// The limits:
// - No retries of its own. The Jev client makes at most 3 attempts per question, the GitHub
//   client at most 2 requests, and writeProseEnrichment at most 2 calls, so one bookmark makes at
//   most 3 + 2 + 3 + 2 = 10 outside requests, the worst case Q3 counts. A test makes the worst
//   case happen and counts them.
// - At most 3 D1 statements, as Q3 counts: the noul, and then either the batch's 2 statements
//   or the failure record. The caller passes the row, which its own query read.
// - A configuration error throws before anything is sent or stored, and isn't recorded as a
//   failure, because it isn't a failure of the bookmark: every bookmark would fail the same way,
//   and recording it would move each one the sweep tries toward Failed. So before the first
//   request, the module reads the threshold and the provider setting, and runs each client's own
//   check of the keys and base URLs this bookmark could need: Jev's (assertJevConfig), GitHub's
//   for a GitHub bookmark (assertGitHubConfig), and the provider's (checkConfiguration).
//   Otherwise an empty Anthropic key would be found only after the Jev questions, and every run
//   would pay for them again. The clients still run the same checks before their own requests.
// - A service that rejects Haystack's own account, rather than the bookmark, throws
//   EnrichmentAccountError, and nothing is recorded against the bookmark (#127). Like a
//   configuration error, it would fail every bookmark the same way until someone fixes it.
// - `last_error` holds fixed codes only (see `lastError`), because the /held page shows it and
//   logs may copy it.
// - Nothing here logs.
//
// The sweep (enrich-pending.ts) enriches several bookmarks at once, so it passes what they share
// (EnrichmentRun): the controller that stops its run, and its pause on GitHub. The on-save path
// enriches one bookmark, and passes neither.
import { describeUrlForJudgment, type UrlDescription } from "@haystack/schemas";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { bookmarks, enrichmentFailures, enrichments } from "../db/schema.ts";
import { type AnthropicTiming, ANTHROPIC_TIMING } from "./anthropic-messages.ts";
import type { EnrichmentInput } from "./enrichment-prompt.ts";
import {
  type ProviderFailureReason,
  type ValidationIssue,
  writeProseEnrichment,
} from "./enrichment-provider.ts";
import { ENRICHMENT_SCHEMA_VERSION } from "./enrichment-schema.ts";
import type { BookmarkFailureClass, FailureClass } from "./failure-class.ts";
import {
  assertGitHubConfig,
  type GitHubConfig,
  type GitHubEvidence,
  type GitHubRequestFailure,
  type GitHubTiming,
  GITHUB_TIMING,
  readGitHubRepository,
} from "./github-client.ts";
import type { GitHubPause } from "./github-pause.ts";
import { type GitHubRepositoryMatch, matchGitHubRepository } from "./github-url.ts";
import { assertJevConfig, type JevConfig, JEV_TIMING, type JevTiming } from "./jev-client.ts";
import { askKind, askSensitivity, type CapturedEvidence } from "./jev-questions.ts";
import { deriveMatchText, MATCH_TEXT_VERSION } from "./match-text.ts";
import { chooseEnrichmentProvider, type ProviderSettingConfig } from "./provider-setting.ts";
import { isHeld, readSensitiveWarnThreshold, type SensitiveWarnThresholdConfig } from "./state.ts";

/** The configuration the module reads. `Env` has all of it, from `vars` and `secrets.required`. */
export type EnrichmentConfig = JevConfig &
  GitHubConfig &
  ProviderSettingConfig &
  SensitiveWarnThresholdConfig;

/**
 * The time limits of each client. The on-save path passes shorter ones, because `ctx.waitUntil`
 * has 30 seconds and the defaults' worst case is longer (see "Jev client" in the plan).
 */
export interface EnrichmentTiming {
  readonly jev: JevTiming;
  readonly github: GitHubTiming;
  readonly provider: AnthropicTiming;
}

export const ENRICHMENT_TIMING: EnrichmentTiming = {
  jev: JEV_TIMING,
  github: GITHUB_TIMING,
  provider: ANTHROPIC_TIMING,
};

/**
 * What the bookmarks of one sweep run share (#127). The on-save path, which enriches one
 * bookmark, passes neither.
 */
export interface EnrichmentRun {
  /**
   * Aborted when the run stops. From then on, the module sends nothing more for the bookmark and
   * records no failure for it, and throws the signal's reason instead, because after an account
   * rejection or an outage a failure may be the same cause again rather than the bookmark's. A
   * request already sent is still answered, and an answer is still stored, the noul or the
   * enrichment, because it was paid for and is about the bookmark.
   *
   * The module aborts it itself, with the EnrichmentAccountError, the moment a service rejects
   * Haystack's account, and then throws that error. The run's other bookmarks then stop at their
   * next step, even one whose next step is only a promise away, such as a GitHub read waiting
   * its turn, rather than when this bookmark's error has reached the caller.
   */
  readonly controller?: AbortController;
  /** The run's pause on GitHub, through which the module reads GitHub (github-pause.ts). */
  readonly github?: GitHubPause;
}

/** The bookmark's columns that the module reads. The caller's query selects them. */
export type BookmarkToEnrich = Pick<
  typeof bookmarks.$inferSelect,
  | "id"
  | "url"
  | "title"
  | "description"
  | "canonicalUrl"
  | "capturedTitle"
  | "capturedDescription"
  | "ogTitle"
  | "ogDescription"
  | "ogSiteName"
  | "sensitiveCanonicalDropped"
  | "sensitivityNoul"
  | "sensitivityAcknowledgedAt"
>;

/**
 * The step whose request failed: the sensitivity question, the `kind` question or the LLM.
 * GitHub isn't one, because a GitHub failure doesn't fail the bookmark.
 */
export type EnrichmentStep = "sensitivity" | "kind" | "llm";

/**
 * Why the step failed, as its client reports it. The Jev client's reasons are among the
 * provider's, and `invalid-output` is writeProseEnrichment's.
 */
export type EnrichmentFailureReason = ProviderFailureReason | "invalid-output";

/** The bookmark was enriched, or another run enriched it at this version first. */
export interface EnrichedOutcome {
  readonly outcome: "enriched";
  // Why GitHub gave nothing, or no README, for a GitHub bookmark. See FailedOutcome. Absent, too,
  // when the run's pause on GitHub meant that nothing was asked.
  readonly github?: GitHubRequestFailure;
}

/** The bookmark is Held, so nothing more was sent, and no failure was recorded. */
export interface HeldOutcome {
  readonly outcome: "held";
}

/**
 * A step failed, and the failure is recorded. The class, the reason and the status are the
 * client's own, so the sweep (#127) can stop a run on an outage without classifying anything
 * again. A rejected account is never a failed outcome: it throws EnrichmentAccountError.
 */
export interface FailedOutcome {
  readonly outcome: "failed";
  readonly step: EnrichmentStep;
  readonly failure: BookmarkFailureClass;
  readonly reason: EnrichmentFailureReason;
  // The response's status, for a `status` failure.
  readonly status?: number;
  // The schema check that the LLM's output failed, for an `invalid-output` failure.
  readonly issue?: ValidationIssue;
  // Why GitHub gave nothing, or no README, for a GitHub bookmark, for the log. The run's pause on
  // GitHub (EnrichmentRun) is what stops asking GitHub after a `rate-limited` failure (see
  // "GitHub enrichment" in the plan), as soon as GitHub answers, before this outcome is ready.
  readonly github?: GitHubRequestFailure;
}

export type EnrichmentOutcome = EnrichedOutcome | HeldOutcome | FailedOutcome;

/** The step at which a service rejected Haystack's account: a failing step, or GitHub. */
export type AccountStep = EnrichmentStep | "github";

/**
 * A service rejected Haystack's own account rather than the bookmark (#127): Jev or the LLM
 * answered 401 or 403, the LLM 402 or a spend limit's 400 (#154), or GitHub 401. Every bookmark
 * would fail the same way until the key, the billing or the limit is fixed, so nothing is
 * recorded against the bookmark, and the caller should stop its run and try again in the next.
 * It is thrown, as a configuration error is, because both are the run's problem rather than the
 * bookmark's, and a caller that stops its run for any thrown error handles it without knowing
 * about it. Every field is a fixed code or a status, so the error is safe to log: it holds no
 * URL, title, response body or key.
 */
export class EnrichmentAccountError extends Error {
  // Like a configuration error's code, so a log reader can match on it.
  readonly code = "ENRICHMENT_ACCOUNT_REJECTED";
  readonly step: AccountStep;
  readonly reason: EnrichmentFailureReason | "unauthorized";
  // The response's status. The clients type theirs as optional, but every account failure comes
  // from a response, so it is set.
  readonly status: number | undefined;

  constructor(
    step: AccountStep,
    reason: EnrichmentFailureReason | "unauthorized",
    status: number | undefined,
  ) {
    const detail = [step, reason, status].filter((part) => part !== undefined).join(":");
    super(`A service rejected Haystack's account (${detail})`);
    this.name = "EnrichmentAccountError";
    this.step = step;
    this.reason = reason;
    this.status = status;
  }
}

// What the clients report about a failed step, once an account failure has been thrown.
interface StepFailure {
  readonly failure: BookmarkFailureClass;
  readonly reason: EnrichmentFailureReason;
  readonly status?: number;
  readonly issue?: ValidationIssue;
}

// The error for a rejected account, once the run, if there is one, is stopped with it.
function accountRejected(
  run: EnrichmentRun,
  step: AccountStep,
  reason: EnrichmentFailureReason | "unauthorized",
  status: number | undefined,
): EnrichmentAccountError {
  const error = new EnrichmentAccountError(step, reason, status);
  run.controller?.abort(error);
  return error;
}

// A client's failure as the bookmark records it. An `account` failure isn't the bookmark's, so
// it stops the run and throws instead, before anything is recorded.
function bookmarkFailure(
  run: EnrichmentRun,
  step: EnrichmentStep,
  {
    failure,
    reason,
    status,
    issue,
  }: {
    readonly failure: FailureClass;
    readonly reason: EnrichmentFailureReason;
    readonly status?: number;
    readonly issue?: ValidationIssue;
  },
): StepFailure {
  if (failure === "account") {
    throw accountRejected(run, step, reason, status);
  }
  return {
    failure,
    reason,
    ...(status === undefined ? {} : { status }),
    ...(issue === undefined ? {} : { issue }),
  };
}

/**
 * Every how many failures in a row a transient failure counts as one attempt (#127). A transient
 * failure on its own doesn't count, so that an outage can't move bookmarks to Failed. But then a
 * bookmark that never succeeds, such as one whose LLM request always times out, would be tried
 * after every backoff window for good, with a paid request each time, and never reach /held.
 * So a transient failure that is the 5th, 10th, 15th… failure in a row, of either class, counts
 * as one attempt: the count is `consecutive_failures`, which every failure raises. With the
 * attempt limit of 3, a bookmark that only ever fails transiently reaches Failed after 15 tries,
 * which the backoff (`backoffWindowMs` in state.ts) spreads over about two and a half days. A
 * permanent failure in the run brings that forward: after two permanent failures, the third
 * transient failure in a row is the 5th failure, so it counts, and the bookmark reaches Failed.
 * An outage shorter than about two and a half days can't fail a bookmark on its own, because the
 * sweep stops a run when its first calls all fail transiently. A longer one can fail the
 * bookmarks each run tries first, which the owner accepted, because recording those failures is
 * what grows their backoff (OUTAGE_STOP_CALLS in enrich-pending.ts). The owner's decision of
 * 2026-10-25, which chose this reading over a count of transient failures alone, which would
 * need a column of its own.
 */
export const TRANSIENT_FAILURES_PER_ATTEMPT = 5;

/**
 * The failure as `last_error` stores it: `<step>:<reason>`, then `:<status>` when the response
 * had one, then `:<issue>` for output that failed validation. For example `sensitivity:timeout`,
 * `kind:status:429` or `llm:invalid-output:use_cases.1: max_length`. Every part is a fixed code
 * from Haystack's own lists, a number, or a ValidationIssue, which names only the schema's keys,
 * list positions and Valibot's check names. So it never holds the URL, captured text, a response
 * body or a key.
 */
function lastError(step: EnrichmentStep, { reason, status, issue }: StepFailure): string {
  return [step, reason, status, issue].filter((part) => part !== undefined).join(":");
}

// The canonical URL as the `kind` question and the LLM get it: describeUrlForJudgment's
// description, never the URL itself (#157). The gate judges `url`, not the canonical URL, which
// the page chose, so a secret in it that detectSensitiveUrl doesn't recognize would otherwise
// reach TypeSafe and the LLM provider in full. The description keeps the host and the word-like
// parts of the path as evidence. It gets no title, because the page's titles are evidence of
// their own, and no flag, because the flag is about a canonical URL that was dropped.
function describedCanonicalUrl(canonicalUrl: string | null): UrlDescription | undefined {
  // POST /save stores only an http or https URL, as the capture payload's schema requires, so
  // this only leaves out a value written some other way, which would otherwise throw for the
  // bookmark on every run, as `withoutSensitiveCanonicalUrl` leaves out one that doesn't parse.
  const url = canonicalUrl === null ? null : URL.parse(canonicalUrl);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return undefined;
  }
  return describeUrlForJudgment(url, undefined, false);
}

// What the bookmark records about the page, as the `kind` question and the LLM get it: a key is
// absent when the row has no value for it.
function capturedEvidence(bookmark: BookmarkToEnrich): CapturedEvidence {
  const canonicalUrl = describedCanonicalUrl(bookmark.canonicalUrl);
  return {
    url: bookmark.url,
    title: bookmark.title,
    ...(bookmark.description === null ? {} : { description: bookmark.description }),
    ...(canonicalUrl === undefined ? {} : { canonical_url: canonicalUrl }),
    ...(bookmark.capturedTitle === null ? {} : { captured_title: bookmark.capturedTitle }),
    ...(bookmark.capturedDescription === null
      ? {}
      : { captured_description: bookmark.capturedDescription }),
    ...(bookmark.ogTitle === null ? {} : { og_title: bookmark.ogTitle }),
    ...(bookmark.ogDescription === null ? {} : { og_description: bookmark.ogDescription }),
    ...(bookmark.ogSiteName === null ? {} : { og_site_name: bookmark.ogSiteName }),
  };
}

interface GitHubRead {
  readonly evidence?: GitHubEvidence;
  readonly failure?: GitHubRequestFailure;
}

// What GitHub says about the bookmark's repository, when the URL is in one. A failure only
// leaves the evidence out, except a 401, from either request, which is the token's (#127). In a
// sweep run, the read goes through the run's pause on GitHub, which leaves the evidence out
// without asking when GitHub rate-limited an earlier read. The read checks the run's signal when
// its turn comes, because the pause can make it wait while the run stops, and it handles a 401
// before its turn ends, so the run is stopped before the next read's turn begins.
async function readGitHub(
  config: GitHubConfig,
  match: GitHubRepositoryMatch | undefined,
  timing: GitHubTiming,
  run: EnrichmentRun,
): Promise<GitHubRead> {
  if (match === undefined) {
    return {};
  }
  const read = async () => {
    run.controller?.signal.throwIfAborted();
    const read = await readGitHubRepository(config, match, timing);
    const failure = read.ok ? read.readmeFailure : read;
    if (failure?.reason === "unauthorized") {
      throw accountRejected(run, "github", failure.reason, failure.status);
    }
    return read;
  };
  const result = run.github === undefined ? await read() : await run.github.read(read);
  if (result === undefined) {
    return {};
  }
  if (!result.ok) {
    const { reason, status } = result;
    return { failure: { reason, ...(status === undefined ? {} : { status }) } };
  }
  return {
    evidence: result.evidence,
    ...(result.readmeFailure === undefined ? {} : { failure: result.readmeFailure }),
  };
}

// Records a failed attempt at the current schema version, in one statement. Every failure, of
// either class, adds one to `consecutive_failures`, which the sweep's backoff grows with. A
// permanent one adds one to `attempts`, which decides the Failed state, and so does a transient
// one that brings `consecutive_failures` to a multiple of TRANSIENT_FAILURES_PER_ATTEMPT, so
// earlier permanent failures in the run count toward that multiple (see "Enrichment sweep" in the
// plan). A permanent failure at such a multiple still adds one, not two: the rule is there for
// transient failures, which otherwise never count, and a permanent one counts already.
async function recordFailure(
  db: Db,
  bookmarkId: string,
  step: EnrichmentStep,
  stepFailure: StepFailure,
  github: GitHubRequestFailure | undefined,
): Promise<FailedOutcome> {
  const permanent = stepFailure.failure === "permanent";
  const lastAttemptAt = Date.now();
  const error = lastError(step, stepFailure);
  // SQLite evaluates every expression in an update against the row before it, so this is the
  // count that this failure brings `consecutive_failures` to.
  const consecutive = sql`(${enrichmentFailures.consecutiveFailures} + 1)`;
  const reachesMultiple = sql`${consecutive} % ${TRANSIENT_FAILURES_PER_ATTEMPT} = 0`;
  await db
    .insert(enrichmentFailures)
    .values({
      bookmarkId,
      schemaVersion: ENRICHMENT_SCHEMA_VERSION,
      // A new record's 1 failure in a row is below TRANSIENT_FAILURES_PER_ATTEMPT, so only a
      // permanent one counts.
      attempts: permanent ? 1 : 0,
      consecutiveFailures: 1,
      lastError: error,
      lastAttemptAt,
    })
    .onConflictDoUpdate({
      target: [enrichmentFailures.bookmarkId, enrichmentFailures.schemaVersion],
      set: {
        attempts: permanent
          ? sql`${enrichmentFailures.attempts} + 1`
          : sql`${enrichmentFailures.attempts} + CASE WHEN ${reachesMultiple} THEN 1 ELSE 0 END`,
        consecutiveFailures: consecutive,
        lastError: error,
        lastAttemptAt,
      },
    });
  const { failure, reason, status, issue } = stepFailure;
  return {
    outcome: "failed",
    step,
    failure,
    reason,
    ...(status === undefined ? {} : { status }),
    ...(issue === undefined ? {} : { issue }),
    ...(github === undefined ? {} : { github }),
  };
}

/**
 * Enriches one bookmark: the sensitivity gate, GitHub, the `kind` question, the LLM, and the
 * write, in that order. Resolves to the outcome, having stored it: the enrichment, or the failure
 * record. Throws for a configuration error, before anything is sent or stored, for a service that
 * rejects Haystack's account (EnrichmentAccountError), and for a D1 error, without recording a
 * failure for any of them. The caller should treat a thrown error as a problem with the run, not
 * with the bookmark, and stop the run. Once `run.controller` is aborted, it sends nothing more
 * and records no failure, and throws the signal's reason (see EnrichmentRun).
 */
export async function enrichBookmark(
  db: Db,
  config: EnrichmentConfig,
  bookmark: BookmarkToEnrich,
  timing: EnrichmentTiming = ENRICHMENT_TIMING,
  run: EnrichmentRun = {},
): Promise<EnrichmentOutcome> {
  // Before each step that sends a request, and before a failure is recorded: a stopped run sends
  // nothing more and records no failure. The account error, which the clients' answers raise,
  // comes first, so a rejection that arrives after the stop is still reported as one.
  const stopIfAborted = () => run.controller?.signal.throwIfAborted();
  // Every configuration error this bookmark could meet, found before anything is sent, so none
  // costs a request. Jev's is always needed, because a bookmark that isn't Held is asked the
  // `kind` question even when its noul is stored. A bookmark that turns out to be Held needs
  // nothing more, but a configuration error is the run's problem whichever bookmark finds it.
  const threshold = readSensitiveWarnThreshold(config);
  const { provider, model } = chooseEnrichmentProvider(config, timing.provider);
  assertJevConfig(config);
  const match = matchGitHubRepository(bookmark.url);
  if (match !== undefined) {
    assertGitHubConfig(config);
  }
  provider.checkConfiguration({ model });

  let noul = bookmark.sensitivityNoul;
  if (noul === null) {
    // The page's own title, which is what the save form's check (#132) will judge too, so a
    // bookmark gets the same description from either. `title` is the user's, which can be the
    // page's sharing title or words of their own.
    const description = describeUrlForJudgment(
      new URL(bookmark.url),
      bookmark.capturedTitle ?? undefined,
      bookmark.sensitiveCanonicalDropped === true,
    );
    stopIfAborted();
    const sensitivity = await askSensitivity(
      config,
      description,
      timing.jev,
      run.controller?.signal,
    );
    if (!sensitivity.ok) {
      const stepFailure = bookmarkFailure(run, "sensitivity", sensitivity);
      stopIfAborted();
      return recordFailure(db, bookmark.id, "sensitivity", stepFailure, undefined);
    }
    noul = sensitivity.answer;
    await db
      .update(bookmarks)
      .set({ sensitivityNoul: noul, sensitivityCheckedAt: Date.now() })
      .where(eq(bookmarks.id, bookmark.id));
  }
  if (isHeld(noul, bookmark.sensitivityAcknowledgedAt, threshold)) {
    return { outcome: "held" };
  }

  const evidence = capturedEvidence(bookmark);
  const github = await readGitHub(config, match, timing.github, run);
  stopIfAborted();
  const kind = await askKind(
    config,
    github.evidence === undefined
      ? { bookmark: evidence }
      : { bookmark: evidence, github: github.evidence },
    timing.jev,
    run.controller?.signal,
  );
  if (!kind.ok) {
    const stepFailure = bookmarkFailure(run, "kind", kind);
    stopIfAborted();
    return recordFailure(db, bookmark.id, "kind", stepFailure, github.failure);
  }
  const input: EnrichmentInput = {
    bookmark: evidence,
    kind: kind.answer.kind,
    ...(github.evidence === undefined ? {} : { github: github.evidence }),
  };
  stopIfAborted();
  const prose = await writeProseEnrichment(provider, input, { model });
  if (!prose.ok) {
    const stepFailure = bookmarkFailure(run, "llm", prose);
    stopIfAborted();
    return recordFailure(db, bookmark.id, "llm", stepFailure, github.failure);
  }

  // D1 runs a batch as one transaction ("Data model" in the plan), so the enrichment and the
  // removal of its failure record are written together or not at all, which a test checks. When
  // another run enriched the bookmark at this version first, the unique (bookmark_id,
  // schema_version) index makes the insert do nothing, and the failure record is removed all the
  // same, because the bookmark is Current either way.
  const now = Date.now();
  await db.batch([
    db
      .insert(enrichments)
      .values({
        id: crypto.randomUUID(),
        bookmarkId: bookmark.id,
        schemaVersion: ENRICHMENT_SCHEMA_VERSION,
        provider: provider.id,
        model: prose.model,
        kind: kind.answer.kind,
        kindProbabilities: kind.answer.probabilities,
        data: prose.enrichment,
        matchText: deriveMatchText({
          title: bookmark.title,
          kind: kind.answer.kind,
          enrichment: prose.enrichment,
        }),
        matchTextVersion: MATCH_TEXT_VERSION,
        createdAt: now,
      })
      .onConflictDoNothing({ target: [enrichments.bookmarkId, enrichments.schemaVersion] }),
    db
      .delete(enrichmentFailures)
      .where(
        and(
          eq(enrichmentFailures.bookmarkId, bookmark.id),
          eq(enrichmentFailures.schemaVersion, ENRICHMENT_SCHEMA_VERSION),
        ),
      ),
  ]);
  return {
    outcome: "enriched",
    ...(github.failure === undefined ? {} : { github: github.failure }),
  };
}
