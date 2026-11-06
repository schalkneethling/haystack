// Splitting a search's bookmarks into chunks that fit Jev's two token budgets (#211). See "Jev
// model limits" in plans/haystack-v1-implementation-plan.md.
//
// The models page (https://docs.typesafe.ai/models.md) gives two context limits: 32k tokens for
// the state plus any one question, and 64k for the whole request, every question included. In
// batched mode, the state holds every bookmark of the chunk and the query, and each bookmark adds
// its own questions, so both grow with the chunk.
//
// The token counts are estimates. On 2026-11-04 neither the documentation index
// (https://docs.typesafe.ai/llms.txt), the models page, Request rules and errors
// (https://docs.typesafe.ai/api/errors.md), the API reference
// (https://docs.typesafe.ai/api/system-one.md) nor the OpenAPI document
// (https://api.typesafe.ai/openapi.json), whose only paths are `/v1/models` and `/v1/systemone`,
// had a token-counting endpoint or said which tokenizer Jev uses. So a request is estimated from
// its JSON, as the client sends it: a token for every 3 UTF-8 bytes, rounded up, which is
// conservative for English, at about 4 characters a token, and counts a character outside ASCII,
// which a tokenizer often makes a token of its own, as 2 to 4 bytes rather than 1. The JSON's
// quotes, keys and escapes are counted too, though Jev may not count them as tokens. Each budget
// then keeps TOKEN_SAFETY_MARGIN of itself unused. #222 calibrates the ratio against
// `usage.input_tokens`, and a chunk that Jev still finds too long is split (chunked-search.ts).
import type { JevQuestion } from "../enrichment/jev-client.ts";
import {
  helpsQuestion,
  questionIds,
  relevanceQuestion,
  searchRequestParts,
  type SearchAsk,
  type SearchBookmark,
} from "./jev-search.ts";

/** Jev's limit for the state plus any one question, from the models page. */
export const JEV_QUESTION_CONTEXT_TOKENS = 32_000;

/** Jev's limit for everything in one request, every question included. */
export const JEV_REQUEST_CONTEXT_TOKENS = 64_000;

/** How many UTF-8 bytes of a request's JSON the estimate counts as one token. */
export const TOKEN_ESTIMATE_BYTES_PER_TOKEN = 3;

/** The share of each budget the chunker leaves unused, for an estimate that is still too low. */
export const TOKEN_SAFETY_MARGIN = 0.1;

/** The state plus the longest question may come to this many estimated tokens. */
export const STATE_BUDGET_TOKENS = Math.floor(
  JEV_QUESTION_CONTEXT_TOKENS * (1 - TOKEN_SAFETY_MARGIN),
);

/** The whole request may come to this many estimated tokens. */
export const REQUEST_BUDGET_TOKENS = Math.floor(
  JEV_REQUEST_CONTEXT_TOKENS * (1 - TOKEN_SAFETY_MARGIN),
);

const encoder = new TextEncoder();

/** The estimated tokens of `value`'s JSON. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(
    encoder.encode(JSON.stringify(value)).byteLength / TOKEN_ESTIMATE_BYTES_PER_TOKEN,
  );
}

/** A request's estimated size, against the two budgets. */
export interface RequestEstimate {
  readonly stateTokens: number;
  readonly longestQuestionTokens: number;
  readonly requestTokens: number;
}

/** The estimated size of the request for `ask`. */
export function estimateSearchRequest(ask: SearchAsk): RequestEstimate {
  const { state, questions } = searchRequestParts(ask);
  return {
    stateTokens: estimateTokens(state),
    longestQuestionTokens: Math.max(...Object.values(questions).map(estimateTokens)),
    requestTokens: estimateTokens({ state, questions }),
  };
}

// The UTF-8 bytes of `value`'s JSON.
function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

// The estimated tokens of this many bytes, as estimateTokens counts them.
function tokensOf(bytes: number): number {
  return Math.ceil(bytes / TOKEN_ESTIMATE_BYTES_PER_TOKEN);
}

// What the bookmark at `index` in a chunk adds to the request's JSON, in bytes: its entry in the
// state's `bookmarks` and its questions, each with its key, a colon and a comma, and the longest
// of its questions on its own. The comma is counted for every entry, the first one's included, so
// the sum is never less than the JSON that searchRequestParts builds.
function bookmarkBytes(
  bookmark: SearchBookmark,
  index: number,
  questions: SearchAsk["questions"],
): { state: number; questions: number; longestQuestion: number } {
  // The alias searchRequestParts gives the bookmark at this index. The questions name the
  // bookmark by it, and its length grows with the index, so they are measured with it.
  const alias = `b_${index}`;
  const ids = questionIds(alias);
  const asked: [string, JevQuestion][] = [];
  if (questions !== "score") {
    asked.push([ids.helps, helpsQuestion(alias)]);
  }
  if (questions !== "noul") {
    asked.push([ids.relevance, relevanceQuestion(alias)]);
  }
  let questionBytes = 0;
  let longestQuestion = 0;
  for (const [id, question] of asked) {
    const bytes = jsonBytes(question);
    questionBytes += jsonBytes(id) + 1 + bytes + 1;
    longestQuestion = Math.max(longestQuestion, bytes);
  }
  const { title, kind, matchText } = bookmark;
  return {
    state: jsonBytes(alias) + 1 + jsonBytes({ title, kind, match_text: matchText }) + 1,
    questions: questionBytes,
    longestQuestion,
  };
}

/**
 * The bookmarks of `ask`, in the order given, in chunks whose requests fit both budgets by the
 * estimate: the state plus the longest question within STATE_BUDGET_TOKENS, and the whole request
 * within REQUEST_BUDGET_TOKENS. A chunk takes bookmarks until the next one wouldn't fit, so its
 * size follows the estimate, not a fixed number of bookmarks. The query is in every chunk's state,
 * so a long query makes every chunk smaller, and with one question asked a bookmark's questions
 * take less room, so a chunk holds more of them. No bookmarks give no chunks.
 *
 * Throws a RangeError for a bookmark that fits no chunk on its own. The caps on the title, the
 * enrichment and the query rule that out (search-chunks.test.ts checks the longest bookmark they
 * allow), so it would be a bug, not a large collection.
 */
export function chunkBookmarks({ query, bookmarks, questions }: SearchAsk): SearchBookmark[][] {
  // `{"query":…,"bookmarks":{}}`, `{}` for the questions, and `{"state":,"questions":}` around
  // both: what every chunk's request has before its first bookmark.
  const emptyState = jsonBytes({ query, bookmarks: {} });
  const emptyRequest = emptyState + jsonBytes({}) + jsonBytes({ state: 0, questions: 0 }) - 2;
  const chunks: SearchBookmark[][] = [];
  let chunk: SearchBookmark[] = [];
  let stateBytes = emptyState;
  let requestBytes = emptyRequest;
  let longestQuestion = 0;
  for (const bookmark of bookmarks) {
    for (;;) {
      const added = bookmarkBytes(bookmark, chunk.length, questions);
      const nextState = stateBytes + added.state;
      const nextRequest = requestBytes + added.state + added.questions;
      const nextLongest = Math.max(longestQuestion, added.longestQuestion);
      if (
        tokensOf(nextState) + tokensOf(nextLongest) <= STATE_BUDGET_TOKENS &&
        tokensOf(nextRequest) <= REQUEST_BUDGET_TOKENS
      ) {
        chunk.push(bookmark);
        stateBytes = nextState;
        requestBytes = nextRequest;
        longestQuestion = nextLongest;
        break;
      }
      if (chunk.length === 0) {
        throw new RangeError("A bookmark is too large for any request to Jev");
      }
      chunks.push(chunk);
      chunk = [];
      stateBytes = emptyState;
      requestBytes = emptyRequest;
      longestQuestion = 0;
    }
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}
