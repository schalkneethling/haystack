// A bookmark's enrichment state. See "Enrichment state is derived, not stored" in
// plans/haystack-v1-implementation-plan.md. No column stores the state, so the sweep, the /held
// page and search all derive it here, from the bookmark's rows.

export type EnrichmentState = "held" | "current" | "failed" | "outdated" | "pending";

/** What the state is derived from. `readEnrichmentStateInputs` reads it for a user's bookmarks. */
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
