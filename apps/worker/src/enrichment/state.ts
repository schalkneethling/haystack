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
  // The bookmark's failure record at the current schema version, if it has one.
  failure: { attempts: number } | null;
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

/** The first state in the plan's table whose condition the bookmark meets. */
export function deriveEnrichmentState(
  {
    sensitivityNoul,
    sensitivityAcknowledgedAt,
    enrichmentVersions,
    failure,
  }: EnrichmentStateInputs,
  { schemaVersion, sensitiveWarnThreshold, attemptLimit }: EnrichmentStatePolicy,
): EnrichmentState {
  // A bookmark that was never checked is not Held. The enrichment module checks it first.
  if (
    sensitivityNoul !== null &&
    sensitivityNoul >= sensitiveWarnThreshold &&
    sensitivityAcknowledgedAt === null
  ) {
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
