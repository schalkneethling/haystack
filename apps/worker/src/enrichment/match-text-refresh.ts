// The sweep's refresh of `match_text` (#127). See "Match text", "Enrichment sweep" and Q3 in
// plans/haystack-v1-implementation-plan.md. When the derivation in match-text.ts changes,
// MATCH_TEXT_VERSION is raised, and each sweep run rewrites the text of a few enrichments at an
// older derivation version from what is stored: the bookmark's title, and the enrichment's kind
// and data. It calls no service, so a refresh costs no Jev or LLM request.
import { and, asc, eq, lt } from "drizzle-orm";
import * as v from "valibot";
import type { Db } from "../db/client.ts";
import { bookmarks, enrichments } from "../db/schema.ts";
import { ENRICHMENT_SCHEMA_VERSION, EnrichmentV1 } from "./enrichment-schema.ts";
import { KINDS } from "./jev-questions.ts";
import { deriveMatchText, MATCH_TEXT_VERSION } from "./match-text.ts";

/**
 * How many enrichments one run rewrites. Q3 counts the refresh as 5 D1 statements of a run's 50
 * subrequests, the read and these rewrites in one `batch()`, so a larger refresh takes several
 * runs. Q3 says to move the schedule back to every 5 minutes while one is under way.
 */
export const MATCH_TEXT_REFRESH_LIMIT = 4;

/** What one run's refresh did, as counts for the sweep's summary. */
export interface MatchTextRefresh {
  // Enrichments whose `match_text` was rewritten at MATCH_TEXT_VERSION.
  readonly refreshed: number;
  // Enrichments at an older derivation whose stored kind or data isn't what the schema says,
  // which were left as they were.
  readonly unreadable: number;
}

const StoredKind = v.picklist(KINDS);

/**
 * Rewrites `match_text` for up to MATCH_TEXT_REFRESH_LIMIT enrichments at an older derivation
 * version, oldest first, in one D1 batch, so they are rewritten together or not at all.
 *
 * Only enrichments at the current ENRICHMENT_SCHEMA_VERSION are refreshed, because deriveMatchText
 * reads EnrichmentV1, the shape that version stores, and another version's data has its own
 * shape. A bookmark whose enrichment is at another version is Outdated, so the sweep enriches it
 * again, and the new enrichment gets the current derivation. Stored JSON is validated when read,
 * as "Data model" in the plan says, because the database doesn't enforce its shape. A row that
 * fails is left as it is and counted, and since it stays at the front of the oldest-first order,
 * it keeps its place in every run until someone looks at it. Only a hand-made change can cause
 * one, because enrichBookmark validates what it stores.
 */
export async function refreshMatchText(db: Db): Promise<MatchTextRefresh> {
  const rows = await db
    .select({
      id: enrichments.id,
      kind: enrichments.kind,
      data: enrichments.data,
      title: bookmarks.title,
    })
    .from(enrichments)
    .innerJoin(bookmarks, eq(bookmarks.id, enrichments.bookmarkId))
    .where(
      and(
        eq(enrichments.schemaVersion, ENRICHMENT_SCHEMA_VERSION),
        lt(enrichments.matchTextVersion, MATCH_TEXT_VERSION),
      ),
    )
    .orderBy(asc(enrichments.createdAt), asc(enrichments.id))
    .limit(MATCH_TEXT_REFRESH_LIMIT);

  const rewrites = [];
  for (const row of rows) {
    const kind = v.safeParse(StoredKind, row.kind);
    const data = v.safeParse(EnrichmentV1, row.data);
    if (kind.success && data.success) {
      const matchText = deriveMatchText({
        title: row.title,
        kind: kind.output,
        enrichment: data.output,
      });
      rewrites.push(
        db
          .update(enrichments)
          .set({ matchText, matchTextVersion: MATCH_TEXT_VERSION })
          .where(eq(enrichments.id, row.id)),
      );
    }
  }
  // `batch()` takes at least one statement.
  const [first, ...rest] = rewrites;
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
  return { refreshed: rewrites.length, unreadable: rows.length - rewrites.length };
}
