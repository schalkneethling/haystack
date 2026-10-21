// Reads what deriveEnrichmentState needs, so callers do not each assemble it from the tables.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { bookmarks, enrichmentFailures, enrichments } from "../db/schema.ts";
import type { EnrichmentStateInputs } from "./state.ts";

export interface BookmarkEnrichmentStateInputs extends EnrichmentStateInputs {
  bookmarkId: string;
}

/**
 * A row of a query that joins each bookmark to its enrichments, and to its failure record at
 * one schema version. A bookmark with no enrichment has one row, with `enrichmentVersion` NULL.
 */
export interface StateInputRow {
  bookmarkId: string;
  sensitivityNoul: number | null;
  sensitivityAcknowledgedAt: number | null;
  enrichmentVersion: number | null;
  failedAttempts: number | null;
}

type CollectedInputs<Row extends StateInputRow> = Omit<
  Row,
  "enrichmentVersion" | "failedAttempts"
> &
  BookmarkEnrichmentStateInputs & { enrichmentVersions: number[] };

/**
 * One set of inputs per bookmark, in the order the rows first name each bookmark.
 * `failureVersion` is the schema version the query joined the failure record at. Any other
 * column the query selected, such as the sweep's backoff columns, is kept from the bookmark's
 * first row, so it must have one value per bookmark.
 */
export function collectStateInputs<Row extends StateInputRow>(
  rows: readonly Row[],
  failureVersion: number,
): CollectedInputs<Row>[] {
  const collected = new Map<string, CollectedInputs<Row>>();
  for (const { enrichmentVersion, failedAttempts, ...columns } of rows) {
    let inputs = collected.get(columns.bookmarkId);
    if (inputs === undefined) {
      inputs = {
        ...columns,
        enrichmentVersions: [],
        failure: failedAttempts === null ? null : { attempts: failedAttempts },
        failureVersion,
      };
      collected.set(columns.bookmarkId, inputs);
    }
    if (enrichmentVersion !== null) {
      inputs.enrichmentVersions.push(enrichmentVersion);
    }
  }
  return [...collected.values()];
}

/**
 * The state inputs of each of the user's bookmarks, oldest first, in one query. Only the
 * failure record at `schemaVersion` is read, and deriveEnrichmentState refuses the inputs
 * with any other version.
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
  return collectStateInputs(rows, schemaVersion);
}
