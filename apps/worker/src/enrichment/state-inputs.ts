// Reads what deriveEnrichmentState needs, so callers do not each assemble it from the tables.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { bookmarks, enrichmentFailures, enrichments } from "../db/schema.ts";
import type { EnrichmentStateInputs } from "./state.ts";

export interface BookmarkEnrichmentStateInputs extends EnrichmentStateInputs {
  bookmarkId: string;
}

interface CollectedInputs extends BookmarkEnrichmentStateInputs {
  enrichmentVersions: number[];
}

/**
 * The state inputs of each of the user's bookmarks, oldest first, in one query. Only the
 * failure record at `schemaVersion` is read, so pass the same version to
 * deriveEnrichmentState.
 */
export async function readEnrichmentStateInputs(
  db: Db,
  userId: string,
  schemaVersion: number,
): Promise<BookmarkEnrichmentStateInputs[]> {
  // One row per enrichment, or one row for a bookmark that has none. A bookmark has at most one
  // failure record per version, so that join adds no rows.
  const rows = await db
    .select({
      bookmarkId: bookmarks.id,
      sensitivityNoul: bookmarks.sensitivityNoul,
      sensitivityAcknowledgedAt: bookmarks.sensitivityAcknowledgedAt,
      enrichmentVersion: enrichments.schemaVersion,
      failedAttempts: enrichmentFailures.attempts,
    })
    .from(bookmarks)
    .leftJoin(enrichments, eq(enrichments.bookmarkId, bookmarks.id))
    .leftJoin(
      enrichmentFailures,
      and(
        eq(enrichmentFailures.bookmarkId, bookmarks.id),
        eq(enrichmentFailures.schemaVersion, schemaVersion),
      ),
    )
    .where(eq(bookmarks.userId, userId))
    .orderBy(asc(bookmarks.createdAt), asc(bookmarks.id), asc(enrichments.schemaVersion));
  const collected = new Map<string, CollectedInputs>();
  for (const row of rows) {
    let inputs = collected.get(row.bookmarkId);
    if (inputs === undefined) {
      inputs = {
        bookmarkId: row.bookmarkId,
        sensitivityNoul: row.sensitivityNoul,
        sensitivityAcknowledgedAt: row.sensitivityAcknowledgedAt,
        enrichmentVersions: [],
        failure: row.failedAttempts === null ? null : { attempts: row.failedAttempts },
      };
      collected.set(row.bookmarkId, inputs);
    }
    if (row.enrichmentVersion !== null) {
      inputs.enrichmentVersions.push(row.enrichmentVersion);
    }
  }
  return [...collected.values()];
}
