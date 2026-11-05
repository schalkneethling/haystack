// Logging a search (#212): one `search_runs` row, and one `search_answers` row for every candidate
// Jev answered, shown or not. See "Data model", Q12 and "Ranking and thresholds" in
// plans/haystack-v1-implementation-plan.md.
//
// The run and its answers are written in one `db.batch()`, which D1 runs as one transaction, so a
// run is never logged without its answers. The answers go in groups, because D1 binds at most
// D1_BOUND_PARAMETER_LIMIT parameters in one statement (Q12).
//
// Each group inserts only the answers whose bookmark is still the user's. A bookmark deleted while
// Jev was answering would otherwise fail the answer's foreign key, and with it the whole batch, so
// the search would be lost for a bookmark that is gone anyway; its answer would have been deleted
// with it a moment later. The same condition keeps another user's bookmark out of the log, should
// a caller ever pass one.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { bookmarks, searchAnswers, searchRuns } from "../db/schema.ts";
import type { ScoreAnswerValue } from "../enrichment/jev-client.ts";

/** The most parameters D1 binds in one statement, from D1's limits page (Q12). */
export const D1_BOUND_PARAMETER_LIMIT = 100;

// What each answer binds: its bookmark, its Noul, its Score's three values, and whether it was
// shown. `clicked` is 0, its default, written as a literal.
const PARAMETERS_PER_ANSWER = 6;

// What each group binds once: the run's ID and the user's ID.
const PARAMETERS_PER_GROUP = 2;

/** How many answers one statement inserts: 16, within D1_BOUND_PARAMETER_LIMIT. */
export const SEARCH_ANSWERS_PER_STATEMENT = Math.floor(
  (D1_BOUND_PARAMETER_LIMIT - PARAMETERS_PER_GROUP) / PARAMETERS_PER_ANSWER,
);

/** A run as the service logs it. Its ID is set here, and `created_at` by the schema. */
export type SearchRunLog = Omit<typeof searchRuns.$inferInsert, "id" | "createdAt">;

/** One candidate's answers as they are logged. A signal that wasn't asked is null. */
export interface SearchAnswerLog {
  readonly bookmarkId: string;
  readonly noul: number | null;
  readonly score: ScoreAnswerValue | null;
  readonly shown: boolean;
}

// The answers of one group, inserted with the run's ID, when their bookmark is still the user's.
// SQLite names a VALUES list's columns column1, column2 and so on, in order, and Drizzle inserts
// into every column of `search_answers` in the table's order, which the SELECT follows.
function answerGroup(db: Db, runId: string, userId: string, answers: readonly SearchAnswerLog[]) {
  const rows = answers.map(
    ({ bookmarkId, noul, score, shown }) =>
      sql`(${bookmarkId}, ${noul}, ${score?.score ?? null}, ${
        score === null ? null : JSON.stringify(score.probabilities)
      }, ${score?.confidence ?? null}, ${Number(shown)})`,
  );
  return db
    .insert(searchAnswers)
    .select(
      sql`SELECT ${runId}, column1, column2, column3, column4, column5, column6, 0 FROM (VALUES ${sql.join(
        rows,
        sql`, `,
      )}) WHERE column1 IN (SELECT ${bookmarks.id} FROM ${bookmarks} WHERE ${bookmarks.userId} = ${userId})`,
    )
    .returning({ bookmarkId: searchAnswers.bookmarkId });
}

/**
 * Writes the run and its answers in one batch, and returns the run's ID and the IDs of the
 * bookmarks whose answers were written, which leaves out any bookmark that was deleted or isn't
 * the user's.
 */
export async function writeSearchLog(
  db: Db,
  run: SearchRunLog,
  answers: readonly SearchAnswerLog[],
): Promise<{ readonly runId: string; readonly loggedBookmarkIds: ReadonlySet<string> }> {
  const id = crypto.randomUUID();
  const groups: ReturnType<typeof answerGroup>[] = [];
  for (let start = 0; start < answers.length; start += SEARCH_ANSWERS_PER_STATEMENT) {
    groups.push(
      answerGroup(db, id, run.userId, answers.slice(start, start + SEARCH_ANSWERS_PER_STATEMENT)),
    );
  }
  const [, ...written] = await db.batch([db.insert(searchRuns).values({ ...run, id }), ...groups]);
  return {
    runId: id,
    loggedBookmarkIds: new Set(written.flat().map(({ bookmarkId }) => bookmarkId)),
  };
}
