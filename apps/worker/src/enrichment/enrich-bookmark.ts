// The enrichment module (#126): one bookmark, from the sensitivity gate to its stored enrichment.
// See "Enrichment design", "Enrichment state is derived, not stored", "Enrichment sweep",
// "Probabilistic check with Jev" and Q3 in plans/haystack-v1-implementation-plan.md. It takes the
// bookmark's row and returns an outcome, and it knows nothing about how it was called, so the
// sweep (#127) and the on-save path (#133) call the same code. Nothing in production calls it yet.
//
// The steps, in order:
// 1. The sensitivity gate, only when the bookmark's `sensitivity_noul` is empty. Jev is sent
//    describeUrlForJudgment's description, never the URL, and the noul is stored with the time.
//    A bookmark at or above SENSITIVE_WARN_THRESHOLD without an acknowledgment is Held: the
//    module stops, nothing about it goes to GitHub, the `kind` question or the LLM, and no
//    failure is recorded, because Held isn't a failed attempt.
// 2. GitHub, when the bookmark is a GitHub repository or a page within one. A GitHub failure
//    never fails the bookmark: the bookmark is enriched from what it captured.
// 3. The `kind` question, with the same evidence the LLM gets.
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
// - `last_error` holds fixed codes only (see `lastError`), because the /held page shows it and
//   logs may copy it.
// - Nothing here logs.
import { describeUrlForJudgment } from "@haystack/schemas";
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
import type { FailureClass } from "./failure-class.ts";
import {
  assertGitHubConfig,
  type GitHubConfig,
  type GitHubEvidence,
  type GitHubRequestFailure,
  type GitHubTiming,
  GITHUB_TIMING,
  readGitHubRepository,
} from "./github-client.ts";
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
  // Why GitHub gave nothing, or no README, for a GitHub bookmark. See FailedOutcome.
  readonly github?: GitHubRequestFailure;
}

/** The bookmark is Held, so nothing more was sent, and no failure was recorded. */
export interface HeldOutcome {
  readonly outcome: "held";
}

/**
 * A step failed, and the failure is recorded. The class, the reason and the status are the
 * client's own, so the sweep (#127) can stop a run on an outage or on rejected credentials
 * without classifying anything again.
 */
export interface FailedOutcome {
  readonly outcome: "failed";
  readonly step: EnrichmentStep;
  readonly failure: FailureClass;
  readonly reason: EnrichmentFailureReason;
  // The response's status, for a `status` failure.
  readonly status?: number;
  // The schema check that the LLM's output failed, for an `invalid-output` failure.
  readonly issue?: ValidationIssue;
  // Why GitHub gave nothing, or no README, for a GitHub bookmark, so the sweep can stop asking
  // GitHub after a `rate-limited` failure and apply its rule for rejected credentials to a 401
  // (see "GitHub enrichment" in the plan).
  readonly github?: GitHubRequestFailure;
}

export type EnrichmentOutcome = EnrichedOutcome | HeldOutcome | FailedOutcome;

// What the clients report about a failed step.
interface StepFailure {
  readonly failure: FailureClass;
  readonly reason: EnrichmentFailureReason;
  readonly status?: number;
  readonly issue?: ValidationIssue;
}

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

// What the bookmark records about the page, as the `kind` question and the LLM get it: a key is
// absent when the row has no value for it.
function capturedEvidence(bookmark: BookmarkToEnrich): CapturedEvidence {
  return {
    url: bookmark.url,
    title: bookmark.title,
    ...(bookmark.description === null ? {} : { description: bookmark.description }),
    ...(bookmark.canonicalUrl === null ? {} : { canonical_url: bookmark.canonicalUrl }),
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
// leaves the evidence out.
async function readGitHub(
  config: GitHubConfig,
  match: GitHubRepositoryMatch | undefined,
  timing: GitHubTiming,
): Promise<GitHubRead> {
  if (match === undefined) {
    return {};
  }
  const result = await readGitHubRepository(config, match, timing);
  if (!result.ok) {
    const { reason, status } = result;
    return { failure: { reason, ...(status === undefined ? {} : { status }) } };
  }
  return {
    evidence: result.evidence,
    ...(result.readmeFailure === undefined ? {} : { failure: result.readmeFailure }),
  };
}

// Records a failed attempt at the current schema version, in one statement. Every failure adds
// one to `consecutive_failures`, which the sweep's backoff grows with, and only a permanent one
// adds one to `attempts`, which decides the Failed state (see "Enrichment sweep" in the plan).
async function recordFailure(
  db: Db,
  bookmarkId: string,
  step: EnrichmentStep,
  stepFailure: StepFailure,
  github: GitHubRequestFailure | undefined,
): Promise<FailedOutcome> {
  const attempts = stepFailure.failure === "permanent" ? 1 : 0;
  const lastAttemptAt = Date.now();
  const error = lastError(step, stepFailure);
  await db
    .insert(enrichmentFailures)
    .values({
      bookmarkId,
      schemaVersion: ENRICHMENT_SCHEMA_VERSION,
      attempts,
      consecutiveFailures: 1,
      lastError: error,
      lastAttemptAt,
    })
    .onConflictDoUpdate({
      target: [enrichmentFailures.bookmarkId, enrichmentFailures.schemaVersion],
      set: {
        attempts: sql`${enrichmentFailures.attempts} + ${attempts}`,
        consecutiveFailures: sql`${enrichmentFailures.consecutiveFailures} + 1`,
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
 * record. Throws for a configuration error, before anything is sent or stored, and for a D1
 * error, without recording a failure for either. The caller should treat a thrown error as a
 * problem with the run, not with the bookmark.
 */
export async function enrichBookmark(
  db: Db,
  config: EnrichmentConfig,
  bookmark: BookmarkToEnrich,
  timing: EnrichmentTiming = ENRICHMENT_TIMING,
): Promise<EnrichmentOutcome> {
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
    const sensitivity = await askSensitivity(config, description, timing.jev);
    if (!sensitivity.ok) {
      return recordFailure(db, bookmark.id, "sensitivity", sensitivity, undefined);
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
  const github = await readGitHub(config, match, timing.github);
  const kind = await askKind(
    config,
    github.evidence === undefined
      ? { bookmark: evidence }
      : { bookmark: evidence, github: github.evidence },
    timing.jev,
  );
  if (!kind.ok) {
    return recordFailure(db, bookmark.id, "kind", kind, github.failure);
  }
  const input: EnrichmentInput = {
    bookmark: evidence,
    kind: kind.answer.kind,
    ...(github.evidence === undefined ? {} : { github: github.evidence }),
  };
  const prose = await writeProseEnrichment(provider, input, { model });
  if (!prose.ok) {
    return recordFailure(db, bookmark.id, "llm", prose, github.failure);
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
