// The bookmarks a search asks Jev about (#212). See "Enrichment state is derived, not stored" in
// plans/haystack-v1-implementation-plan.md.
//
// A candidate is one of the user's bookmarks that has at least one enrichment and isn't Held,
// with its most recent enrichment, whatever that enrichment's schema version. Its state is
// derived as /held and the sweep derive it, from the user's state input rows (state-inputs.ts)
// through collectStateInputs and deriveEnrichmentState, so the three can't disagree about which
// bookmarks are Held. Held is judged against the policy's threshold, the current
// SENSITIVE_WARN_THRESHOLD, so a bookmark that a lowered threshold holds leaves search at once.
// A Failed bookmark that still has an older enrichment stays a candidate, as the state's table
// says.
import type { Db } from "../db/client.ts";
import { bookmarks, enrichments } from "../db/schema.ts";
import { collectStateInputs, selectStateInputRows } from "../enrichment/state-inputs.ts";
import { deriveEnrichmentState, type EnrichmentStatePolicy } from "../enrichment/state.ts";

/** A bookmark a search asks about, with what the page shows of it and what Jev is sent. */
export interface SearchCandidate {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  /** When it was saved: `bookmarks.created_at`, which also breaks ties in the ranking. */
  readonly createdAt: number;
  /** The `kind` of its most recent enrichment. */
  readonly kind: string;
  /** The `match_text` of the same enrichment. */
  readonly matchText: string;
}

interface LatestEnrichment {
  readonly kind: string;
  readonly matchText: string;
  readonly createdAt: number;
  readonly schemaVersion: number;
}

// Whether `a` is more recent than `b`: written later, or, written in the same millisecond, at the
// higher schema version, so that the choice never depends on the order the rows came in.
function isMoreRecent(a: LatestEnrichment, b: LatestEnrichment): boolean {
  return a.createdAt !== b.createdAt
    ? a.createdAt > b.createdAt
    : a.schemaVersion > b.schemaVersion;
}

/**
 * The user's candidates, oldest saved first, in one query. Every row is the user's: the query
 * filters by `userId`, and nothing else is read.
 */
export async function readSearchCandidates(
  db: Db,
  userId: string,
  policy: EnrichmentStatePolicy,
): Promise<SearchCandidate[]> {
  const rows = await selectStateInputRows(db, userId, policy.schemaVersion, {
    title: bookmarks.title,
    description: bookmarks.description,
    url: bookmarks.url,
    savedAt: bookmarks.createdAt,
    kind: enrichments.kind,
    matchText: enrichments.matchText,
    enrichedAt: enrichments.createdAt,
  });

  // The rows hold one enrichment each, so the most recent one is chosen here. collectStateInputs
  // keeps only the bookmark's own columns, which are the same in each of its rows.
  const latest = new Map<string, LatestEnrichment>();
  for (const { bookmarkId, enrichmentVersion, kind, matchText, enrichedAt } of rows) {
    if (enrichmentVersion === null || kind === null || matchText === null || enrichedAt === null) {
      continue;
    }
    const enrichment = { kind, matchText, createdAt: enrichedAt, schemaVersion: enrichmentVersion };
    const current = latest.get(bookmarkId);
    if (current === undefined || isMoreRecent(enrichment, current)) {
      latest.set(bookmarkId, enrichment);
    }
  }

  return collectStateInputs(rows, policy.schemaVersion).flatMap((inputs) => {
    const enrichment = latest.get(inputs.bookmarkId);
    if (enrichment === undefined || deriveEnrichmentState(inputs, policy) === "held") {
      return [];
    }
    return [
      {
        id: inputs.bookmarkId,
        title: inputs.title,
        description: inputs.description,
        url: inputs.url,
        createdAt: inputs.savedAt,
        kind: enrichment.kind,
        matchText: enrichment.matchText,
      },
    ];
  });
}
