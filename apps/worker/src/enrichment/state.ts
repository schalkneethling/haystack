// A bookmark's enrichment state. See "Enrichment state is derived, not stored" in
// plans/haystack-v1-implementation-plan.md. No column stores the state, so the sweep, the /held
// page and search all derive it here, from the bookmark's rows.

export type EnrichmentState = "held" | "current" | "failed" | "outdated" | "pending";

/**
 * What the state is derived from. `readEnrichmentStateInputs` reads it for a user's bookmarks,
 * and the sweep's `selectBookmarksToEnrich` for every user's, both through `collectStateInputs`.
 */
export interface EnrichmentStateInputs {
  // Jev's probability that the URL grants private access. NULL means not yet checked.
  sensitivityNoul: number | null;
  // Set when the user confirmed that the link is not private.
  sensitivityAcknowledgedAt: number | null;
  // The schema version of each of the bookmark's enrichments, in any order.
  enrichmentVersions: readonly number[];
  // The bookmark's failure record at `failureVersion`, if it has one.
  failure: { attempts: number } | null;
  // The schema version the failure record was read at. It must be the current one.
  failureVersion: number;
}

/** The configuration the state depends on. */
export interface EnrichmentStatePolicy {
  // The schema version that enrichment writes now.
  schemaVersion: number;
  // SENSITIVE_WARN_THRESHOLD. A noul at or above it is a warning.
  sensitiveWarnThreshold: number;
  // How many permanent failures at one schema version leave a bookmark for manual attention.
  attemptLimit: number;
}

/** The configuration the warning threshold is read from. `Env` has it, from `vars`. */
export interface SensitiveWarnThresholdConfig {
  // A decimal number from 0 to 1, as a string, because every `var` is one.
  SENSITIVE_WARN_THRESHOLD: string;
}

// From 0 to 1, written out as a decimal, such as `0.5`. Number() would also read `""` as 0,
// `0x1` as 1 and ` 1e-1 ` as 0.1, so a mistyped value could quietly hold every bookmark.
const THRESHOLD = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/;

/**
 * SENSITIVE_WARN_THRESHOLD as a number. Throws for any other value, before anything is sent,
 * because a threshold that can't be read is a configuration error: it would hold every bookmark
 * or none, whichever way it was guessed.
 */
export function readSensitiveWarnThreshold({
  SENSITIVE_WARN_THRESHOLD: value,
}: SensitiveWarnThresholdConfig): number {
  // The value can be missing, although `Env` says `string`, when a test's configuration leaves
  // it out.
  if (typeof value !== "string" || !THRESHOLD.test(value)) {
    throw Object.assign(
      new Error(
        `SENSITIVE_WARN_THRESHOLD is ${JSON.stringify(value)}, which isn't a decimal number from 0 to 1`,
      ),
      { code: "SENSITIVE_WARN_THRESHOLD_INVALID" },
    );
  }
  return Number(value);
}

/**
 * Whether a bookmark is Held: its noul is at or above the threshold, and the user hasn't
 * confirmed that the link isn't private. The state's table and the enrichment module's gate
 * (enrich-bookmark.ts) both use this, so they can't disagree about which bookmark is Held.
 */
export function isHeld(
  sensitivityNoul: number | null,
  sensitivityAcknowledgedAt: number | null,
  sensitiveWarnThreshold: number,
): boolean {
  // A bookmark that was never checked is not Held. The enrichment module checks it first.
  return (
    sensitivityNoul !== null &&
    sensitivityNoul >= sensitiveWarnThreshold &&
    sensitivityAcknowledgedAt === null
  );
}

/**
 * The first state in the plan's table whose condition the bookmark meets. Throws when the
 * inputs were read at another schema version, because the bookmark's failure record at this
 * one would be missing, and it could never be Failed.
 */
export function deriveEnrichmentState(
  {
    sensitivityNoul,
    sensitivityAcknowledgedAt,
    enrichmentVersions,
    failure,
    failureVersion,
  }: EnrichmentStateInputs,
  { schemaVersion, sensitiveWarnThreshold, attemptLimit }: EnrichmentStatePolicy,
): EnrichmentState {
  if (failureVersion !== schemaVersion) {
    throw new Error(
      `Enrichment state inputs were read at schema version ${failureVersion}, not ${schemaVersion}`,
    );
  }
  if (isHeld(sensitivityNoul, sensitivityAcknowledgedAt, sensitiveWarnThreshold)) {
    return "held";
  }
  if (enrichmentVersions.includes(schemaVersion)) {
    return "current";
  }
  if (failure !== null && failure.attempts >= attemptLimit) {
    return "failed";
  }
  // Normally an older version. A newer one is possible after the Worker is rolled back past a
  // schema version change, and it is treated the same way: it stays searchable, and the sweep
  // enriches the bookmark at the current version.
  if (enrichmentVersions.length > 0) {
    return "outdated";
  }
  return "pending";
}

/**
 * The backoff window after a bookmark's first failure in a row. While there is a backlog the
 * sweep is to run every 5 minutes, so a bookmark that just failed would sit out the next two
 * runs, and the others take its place. The owner's decision of 2026-10-25 (#127).
 */
export const BACKOFF_INITIAL_MS = 15 * 60 * 1000;

/**
 * The longest backoff window, also the owner's decision of 2026-10-25 (#127). A bookmark that
 * keeps failing is still tried 4 times a day, so its 15 tries to Failed
 * (TRANSIENT_FAILURES_PER_ATTEMPT in enrich-bookmark.ts) take about two and a half days rather
 * than weeks, and a fixed outage is caught up within 6 hours.
 */
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * How long after its last attempt a bookmark that has failed `consecutiveFailures` times in a row
 * waits before it is tried again: 15 minutes, doubling with each failure, up to 6 hours (#127).
 * So 15 and 30 minutes, then 1, 2 and 4 hours, then 6 hours from the 6th failure on. A bookmark
 * with no failure record has no window. The count is a column of whole numbers, so any other
 * value is a bug in the caller, and throws. The sweep's selection (selectBookmarksToEnrich in
 * enrich-pending.ts) leaves out a bookmark within its window.
 */
export function backoffWindowMs(consecutiveFailures: number): number {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) {
    throw new RangeError(
      `consecutiveFailures is ${consecutiveFailures}, which isn't a whole number from 0`,
    );
  }
  if (consecutiveFailures === 0) {
    return 0;
  }
  // 2 ** n is Infinity past 1023, and Math.min still caps it.
  return Math.min(BACKOFF_INITIAL_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
}
