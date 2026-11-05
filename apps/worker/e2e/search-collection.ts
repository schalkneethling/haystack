// A collection of enriched bookmarks for the browser tests that search through the Worker's own
// /api/search (#214), and the Jev answers that rank it. The tests that stub the route
// (search-answers.ts) need none of this. Only the sweep enriches a bookmark, and it calls Jev, so
// each helper writes the rows it would have written, with the seed helpers the integration tests
// use, through `run`, which executes a statement in the Worker's D1.
import { ENRICHMENT_SCHEMA_VERSION } from "../src/enrichment/enrichment-schema.ts";
import { seedBookmark, seedBookmarks, seedEnrichment, seedEnrichments } from "../test/seed.ts";
import type { HaystackWorker } from "./fixtures.ts";

export { answerBy } from "../test/search-match-text-answers.ts";

// The part of D1 the seed helpers call, over the fixture's `run`.
function seedTarget(run: HaystackWorker["run"]) {
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({ run: () => run(sql, ...values) }),
    }),
  };
}

/**
 * The signed-in test user's ID. Each `signIn` seeds a user of its own, and the browser holds the
 * session of the last one, so that is the newest.
 */
export async function signedInUserId(query: HaystackWorker["query"]): Promise<string> {
  const rows = await query("SELECT id FROM users ORDER BY created_at DESC, rowid DESC LIMIT 1");
  return String(rows[0]?.id);
}

/**
 * Empties the Worker's bookmarks and search log. The Worker's database is shared by the tests of
 * a process, and a search reads every bookmark the user has, so a test that searches starts from
 * nothing.
 */
export async function clearCollection(run: HaystackWorker["run"]): Promise<void> {
  // The runs first: deleting a bookmark deletes its answers, and a run keeps none of its own.
  await run("DELETE FROM search_runs");
  await run("DELETE FROM bookmarks");
}

/** One bookmark with one enrichment, whose `match_text` is how the Jev answer finds it. */
export interface EnrichedBookmark {
  readonly title: string;
  readonly description?: string;
  /** What Jev's answer is looked up by (`answerBy`). */
  readonly matchText: string;
  /** When it was saved, in milliseconds since the epoch. */
  readonly createdAt: number;
}

/** Saves each bookmark with its enrichment, and returns their IDs in the same order. */
export async function seedEnriched(
  run: HaystackWorker["run"],
  userId: string,
  prefix: string,
  bookmarks: readonly EnrichedBookmark[],
): Promise<string[]> {
  const target = seedTarget(run);
  const ids: string[] = [];
  for (const [index, { title, description, matchText, createdAt }] of bookmarks.entries()) {
    const url = `https://example.com/${prefix}-${index}`;
    const id = await seedBookmark(target, userId, url, url, {
      title,
      ...(description === undefined ? {} : { description }),
      createdAt,
    });
    await seedEnrichment(target, id, ENRICHMENT_SCHEMA_VERSION, { matchText, kind: "tool" });
    ids.push(id);
  }
  return ids;
}

/**
 * `count` bookmarks with a `match_text` of 2,000 characters, which Jev's request can't hold at
 * once, so a search of them makes several requests. Each one's `match_text` starts with its
 * number.
 */
export async function seedManyEnriched(
  run: HaystackWorker["run"],
  userId: string,
  prefix: string,
  count: number,
): Promise<string[]> {
  const target = seedTarget(run);
  const ids = await seedBookmarks(
    target,
    userId,
    Array.from({ length: count }, (_, index) => {
      const url = `https://example.com/${prefix}-${index}`;
      return { url, normalizedUrl: url, createdAt: index };
    }),
  );
  await seedEnrichments(
    target,
    ids.map((bookmarkId, index) => ({
      bookmarkId,
      schemaVersion: ENRICHMENT_SCHEMA_VERSION,
      matchText: `${index} ${"x".repeat(2000)}`,
    })),
  );
  return ids;
}
