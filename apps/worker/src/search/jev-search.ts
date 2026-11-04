// Search's questions for Jev (#210): how well each bookmark serves a query. See "Question design",
// "Jev model limits", "Request modes" and "Jev client" in plans/haystack-v1-implementation-plan.md.
// One request holds the query and a set of bookmarks in its state, and asks a Noul (`helps`), a
// Score (`relevance`) or both about each bookmark. This module takes plain values and returns
// validated answers. Splitting a large set into chunks (#211), reading the database and ranking
// (#212) are the callers' work.
//
// The question shapes and the answer fields come from TypeSafe's API reference
// (https://docs.typesafe.ai/api/system-one.md), the Noul page
// (https://docs.typesafe.ai/primitives/noul.md) and the Score page
// (https://docs.typesafe.ai/primitives/score.md), read on 2026-11-01.
//
// A Noul and a Score are different signals, and they stay in different fields. A Noul is the
// probability that the answer to a yes-or-no question is yes, so a Noul near 0.5 means that yes and
// no are about equally likely, not that the bookmark is half relevant. A Score is a position on
// four ordered levels, from 0 to 3, which Jev computes as the probability-weighted mean of the
// level numbers. Both are kept as Jev returns them.
//
// Each bookmark is named in the state and in its questions by an alias, `b_0`, `b_1` and so on,
// in the order the caller gives them, and never by its ID. "How to build with TypeSafe"
// (https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md, read on 2026-11-01) says:
// "Use a backticked dot-and-index path to point a question at a specific nested value, such as
// `support.tickets[0].message`." Neither it nor the primitives page
// (https://docs.typesafe.ai/primitives.md, "Reference specific fields", read the same day) gives a
// grammar for a key with hyphens, which a bookmark's UUID has, or for one that starts with a
// digit. An alias is a plain identifier, so `bookmarks.b_3` is
// unambiguous, and it is also shorter, which matters because each bookmark's key is repeated in
// both of its questions (see "Jev model limits").
//
// No long-context header is sent: the client sends none, and Phase 11 wants none.
import type { searchRuns } from "../db/schema.ts";
import {
  askJevQuestions,
  JEV_ATTEMPT_LIMIT,
  JEV_TIMING,
  type JevConfig,
  type JevQuestions,
  type JevRequestGate,
  type JevResult,
  type JevTiming,
  NoulAnswer,
  type NoulQuestion,
  type ScoreAnswerValue,
  type ScoreQuestion,
  scoreAnswer,
} from "../enrichment/jev-client.ts";
import * as v from "valibot";

/** Which questions a search asks: both, or only one of them. The `search_runs.questions` column. */
export type SearchQuestions = (typeof searchRuns.$inferSelect)["questions"];

/**
 * How long one search request may take. Search keeps the client's 3 attempts, although Workers
 * Paid's 10,000 subrequests no longer make the cap necessary as they did for Q3 on Workers Free,
 * because a person waits for the answer: the third attempt already brings the worst case without
 * a `Retry-After` to 16.5 seconds, and another would add 5 more and a backoff of 2. The decision
 * and its reasons are recorded in "Jev client" in the plan (#210).
 */
export const SEARCH_TIMING: JevTiming = { ...JEV_TIMING, attemptLimit: JEV_ATTEMPT_LIMIT };

/** What search sends about a bookmark. Nothing else from the bookmark is sent. */
export interface SearchBookmark {
  // Never sent. The answers come back under this ID.
  readonly id: string;
  readonly title: string;
  // The `kind` from the bookmark's most recent enrichment.
  readonly kind: string;
  // The `match_text` from the same enrichment.
  readonly matchText: string;
}

/** One search request: the query, the bookmarks it is about, and which questions to ask. */
export interface SearchAsk {
  readonly query: string;
  readonly bookmarks: readonly SearchBookmark[];
  readonly questions: SearchQuestions;
}

/**
 * A bookmark's answers. A signal that wasn't asked for is null, as its column is in
 * `search_answers`.
 */
export interface BookmarkAnswers {
  readonly bookmarkId: string;
  // The `helps` Noul: the probability that the bookmark would help, from 0 to 1.
  readonly noul: number | null;
  // The `relevance` Score, as Jev returned it: `score` from 0 to 3, `probabilities` keyed "0" to
  // "3", and `confidence`.
  readonly score: ScoreAnswerValue | null;
}

// The path to the bookmark with this alias, in backticks, as the questions name it.
function bookmarkPath(alias: string): string {
  return `\`bookmarks.${alias}\``;
}

/** The `helps` question about the bookmark with this alias, worded as in "Question design". */
export function helpsQuestion(alias: string): NoulQuestion {
  return {
    type: "noul",
    instructions: `Would ${bookmarkPath(alias)} help the person with what \`query\` describes?`,
    criteria: {
      true: "The bookmark directly serves the need in the query.",
      false: "The bookmark is only on a related topic, or unrelated.",
    },
  };
}

/**
 * The `relevance` levels, from 0 to 3. Each describes a situation, because the Score page says
 * that each level is judged on its own, without its number or its neighbours.
 */
const RELEVANCE_LEVELS = [
  "Unrelated to the need",
  "Same general area, but would not help with this specific need",
  "Partially addresses the need, or is one of several reasonable options",
  "Directly addresses the need",
] as const;

/**
 * The highest `score` the API can return for the `relevance` question, 3 with the four levels
 * above: the levels are numbered from 0, and `score` is their probability-weighted mean, so it
 * can't pass the last level's number. The Score threshold's range ends here (`readSearchSettings`
 * in flags.ts, #255), so a change to the levels changes the range with it.
 */
export const RELEVANCE_SCORE_MAX = RELEVANCE_LEVELS.length - 1;

/** The `relevance` question about the bookmark with this alias, worded as in "Question design". */
export function relevanceQuestion(alias: string): ScoreQuestion {
  return {
    type: "score",
    instructions: `How well does ${bookmarkPath(alias)} serve the need described in \`query\`?`,
    criteria: RELEVANCE_LEVELS,
  };
}

/**
 * The schema of a `relevance` answer. The contract check (evals/contract-checks.ts, #203)
 * validates TypeSafe's live answer with it too.
 */
export const RelevanceAnswer = scoreAnswer(RELEVANCE_LEVELS.length);

/** The names of a bookmark's two questions in the request and the response. */
export function questionIds(alias: string): { readonly helps: string; readonly relevance: string } {
  return { helps: `${alias}_helps`, relevance: `${alias}_relevance` };
}

/** The request's state, its questions, and each bookmark's alias, in the caller's order. */
export interface SearchRequestParts {
  readonly state: {
    readonly query: string;
    readonly bookmarks: Readonly<
      Record<string, { readonly title: string; readonly kind: string; readonly match_text: string }>
    >;
  };
  readonly questions: JevQuestions;
  readonly aliases: readonly string[];
}

/**
 * The state and the questions of the request for `ask`. Throws a RangeError, before anything is
 * sent, for no bookmarks, which the API would refuse with no questions, or for a bookmark ID given
 * twice, whose answers couldn't be told apart. Both are bugs in the caller.
 */
export function searchRequestParts({ query, bookmarks, questions }: SearchAsk): SearchRequestParts {
  if (bookmarks.length === 0) {
    throw new RangeError("A search request needs at least one bookmark");
  }
  if (new Set(bookmarks.map(({ id }) => id)).size !== bookmarks.length) {
    throw new RangeError("A search request names a bookmark more than once");
  }
  const aliases = bookmarks.map((_, index) => `b_${index}`);
  const state: SearchRequestParts["state"] = {
    query,
    bookmarks: Object.fromEntries(
      bookmarks.map(({ title, kind, matchText }, index) => [
        aliases[index],
        { title, kind, match_text: matchText },
      ]),
    ),
  };
  const asked: Record<string, NoulQuestion | ScoreQuestion> = {};
  for (const alias of aliases) {
    const ids = questionIds(alias);
    if (questions !== "score") {
      asked[ids.helps] = helpsQuestion(alias);
    }
    if (questions !== "noul") {
      asked[ids.relevance] = relevanceQuestion(alias);
    }
  }
  return { state, questions: asked, aliases };
}

// The answer to question `id`, parsed with `schema`, or undefined when it is missing or invalid.
function answerTo<Answer>(
  answers: Readonly<Record<string, unknown>>,
  id: string,
  schema: v.GenericSchema<unknown, Answer>,
): Answer | undefined {
  if (!Object.hasOwn(answers, id)) {
    return undefined;
  }
  const parsed = v.safeParse(schema, answers[id]);
  return parsed.success ? parsed.output : undefined;
}

/**
 * Asks Jev how well each bookmark serves the query, in one request, and returns each bookmark's
 * answers in the order given, with the model that answered and `usage.input_tokens`.
 *
 * A response that leaves out, or malforms, the answer to any question that was asked makes the
 * whole request an `invalid-response`, which is permanent: no answer is returned for any
 * bookmark, and it isn't retried. Splitting the set and asking again is #211's. Retries and the
 * other failures are askJevQuestions', with SEARCH_TIMING's attempts unless `timing` says
 * otherwise, and every attempt waits on `gate` first when one is given: search's limiter
 * (jev-limiter.ts, #211). Rejects with searchRequestParts' RangeErrors and the client's
 * configuration errors before anything is sent.
 */
export async function askSearch(
  config: JevConfig,
  ask: SearchAsk,
  timing: JevTiming = SEARCH_TIMING,
  signal?: AbortSignal,
  gate?: JevRequestGate,
): Promise<JevResult<readonly BookmarkAnswers[]>> {
  const { state, questions, aliases } = searchRequestParts(ask);
  const asksNoul = ask.questions !== "score";
  const asksScore = ask.questions !== "noul";
  return askJevQuestions(
    config,
    state,
    questions,
    (answers) => {
      const read: BookmarkAnswers[] = [];
      for (const [index, alias] of aliases.entries()) {
        const ids = questionIds(alias);
        const noul = asksNoul ? answerTo(answers, ids.helps, NoulAnswer) : null;
        const score = asksScore ? answerTo(answers, ids.relevance, RelevanceAnswer) : null;
        const bookmark = ask.bookmarks[index];
        if (noul === undefined || score === undefined || bookmark === undefined) {
          return undefined;
        }
        read.push({ bookmarkId: bookmark.id, noul, score });
      }
      return read;
    },
    timing,
    signal,
    gate,
  );
}
