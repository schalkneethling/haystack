// Splitting a search's bookmarks into chunks that fit Jev's two token budgets (#211). See "Jev
// model limits" in plans/haystack-v1-implementation-plan.md. Every check here is on the
// estimate, which is what the chunker can know before anything is sent: a request that Jev still
// finds too large is split again after the fact (chunked-search.test.ts).
import { CAPTURE_CAPS, SEARCH_QUERY_CAP } from "@haystack/schemas";
import { describe, expect, it } from "vite-plus/test";
import { ENRICHMENT_CAPS } from "../src/enrichment/enrichment-schema.ts";
import { KINDS } from "../src/enrichment/jev-questions.ts";
import { deriveMatchText } from "../src/enrichment/match-text.ts";
import type { SearchAsk, SearchBookmark, SearchQuestions } from "../src/search/jev-search.ts";
import {
  chunkBookmarks,
  estimateSearchRequest,
  estimateTokens,
  REQUEST_BUDGET_TOKENS,
  STATE_BUDGET_TOKENS,
} from "../src/search/search-chunks.ts";

// The character whose JSON costs the estimate most for one UTF-16 code unit, which is what every
// cap counts: a control character, which JSON writes as a six-byte escape such as `\u0001`. No
// real text is made of it, so a bookmark of it is a bound that no real bookmark reaches.
const WORST = "\u0001";

/** `length` code units of the worst character. */
function worst(length: number): string {
  return WORST.repeat(length);
}

// The longest `kind`, so the longest bookmark's `kind` field is as long as it can be.
const LONGEST_KIND = KINDS.reduce((longest, kind) =>
  kind.length > longest.length ? kind : longest,
);

/**
 * The longest bookmark that saving and enrichment allow: a title at its cap, and a `match_text`
 * derived from an enrichment at every cap, about 2,000 characters (see "Match text" in the plan),
 * all of the worst character.
 */
function longestBookmark(id: string): SearchBookmark {
  const title = worst(CAPTURE_CAPS.title);
  const sentences = Array.from({ length: ENRICHMENT_CAPS.sentences }, () =>
    worst(ENRICHMENT_CAPS.sentence),
  );
  const terms = Array.from({ length: ENRICHMENT_CAPS.terms }, () => worst(ENRICHMENT_CAPS.term));
  return {
    id,
    title,
    kind: LONGEST_KIND,
    matchText: deriveMatchText({
      title,
      kind: LONGEST_KIND,
      enrichment: {
        summary: worst(ENRICHMENT_CAPS.summary),
        use_cases: sentences,
        problems_solved: sentences,
        technologies: terms,
        topics: terms,
        alternative_terms: terms,
      },
    }),
  };
}

// A bookmark like the production ones: a short title and a `match_text` of a few hundred
// characters of plain English (#130 measured 450 to 645).
function typicalBookmark(id: string): SearchBookmark {
  return {
    id,
    title: `Bookmark ${id}`,
    kind: "tool",
    matchText: `Bookmark ${id}\nKind: tool\n${"A test runner for JavaScript projects. ".repeat(12)}`,
  };
}

// A bookmark whose `match_text` is one short line, so its two questions cost more than its state.
function shortBookmark(id: string): SearchBookmark {
  return { id, title: id, kind: "tool", matchText: `${id}.` };
}

function collection(size: number, make: (id: string) => SearchBookmark): SearchBookmark[] {
  return Array.from({ length: size }, (_, index) => make(`bookmark-${index}`));
}

const QUERY = "a test runner for a Vite project";

function chunked(
  bookmarks: readonly SearchBookmark[],
  questions: SearchQuestions = "both",
  query = QUERY,
): SearchBookmark[][] {
  return chunkBookmarks({ query, bookmarks, questions });
}

// Whether the request for `ask` fits both budgets, by the estimate.
function fits(ask: SearchAsk): boolean {
  const estimate = estimateSearchRequest(ask);
  return (
    estimate.stateTokens + estimate.longestQuestionTokens <= STATE_BUDGET_TOKENS &&
    estimate.requestTokens <= REQUEST_BUDGET_TOKENS
  );
}

describe("estimateTokens", () => {
  it("counts a third of a token for each UTF-8 byte of the JSON, rounded up", () => {
    // `"ab"` is 4 bytes, `"語"` is 5 (3 for the character), and `"\u0001"` is 8.
    expect(estimateTokens("ab")).toBe(2);
    expect(estimateTokens("語")).toBe(2);
    expect(estimateTokens(WORST)).toBe(3);
    expect(estimateTokens({ query: "abc" })).toBe(5);
  });
});

describe("chunkBookmarks", () => {
  const sizes = [1, 7, 40, 41, 200, 1000];
  const shapes = [
    ["the longest allowed", longestBookmark],
    ["typical", typicalBookmark],
    ["one-line", shortBookmark],
  ] as const;

  describe.each(shapes)("with %s bookmarks", (_, make) => {
    it.each(sizes)("keeps each chunk of %i inside both budgets", (size) => {
      const bookmarks = collection(size, make);
      for (const questions of ["both", "noul", "score"] as const) {
        const chunks = chunked(bookmarks, questions);
        // Every bookmark is in exactly one chunk, in the order given.
        expect(chunks.flat()).toEqual(bookmarks);
        for (const chunk of chunks) {
          expect(chunk.length).toBeGreaterThan(0);
          const estimate = estimateSearchRequest({ query: QUERY, bookmarks: chunk, questions });
          expect(estimate.stateTokens + estimate.longestQuestionTokens).toBeLessThanOrEqual(
            STATE_BUDGET_TOKENS,
          );
          expect(estimate.requestTokens).toBeLessThanOrEqual(REQUEST_BUDGET_TOKENS);
        }
        // A chunk is closed only when the next bookmark wouldn't fit it, so the chunks are sized
        // by the estimate rather than by a fixed number of bookmarks.
        for (const [index, chunk] of chunks.slice(0, -1).entries()) {
          const next = chunks[index + 1]?.[0];
          expect(next).toBeDefined();
          expect(fits({ query: QUERY, bookmarks: [...chunk, next!], questions })).toBe(false);
        }
      }
    });
  });

  // With long `match_text`, the state reaches the 32k budget first; with one-line ones, the
  // questions, which grow with each bookmark, reach the 64k budget first. So both budgets limit a
  // chunk, each for its own kind of collection.
  it("is limited by the state for long bookmarks, and by the questions for short ones", () => {
    // The estimate of the first chunk with the second chunk's first bookmark added: the request
    // the chunker turned down.
    const turnedDown = (bookmarks: SearchBookmark[]) => {
      const chunks = chunked(bookmarks);
      expect(chunks.length).toBeGreaterThan(1);
      const [first, second] = chunks;
      return estimateSearchRequest({
        query: QUERY,
        bookmarks: [...first!, second![0]!],
        questions: "both",
      });
    };
    const long = turnedDown(collection(1000, longestBookmark));
    expect(long.stateTokens + long.longestQuestionTokens).toBeGreaterThan(STATE_BUDGET_TOKENS);
    expect(long.requestTokens).toBeLessThanOrEqual(REQUEST_BUDGET_TOKENS);
    const short = turnedDown(collection(1000, shortBookmark));
    expect(short.stateTokens + short.longestQuestionTokens).toBeLessThanOrEqual(
      STATE_BUDGET_TOKENS,
    );
    expect(short.requestTokens).toBeGreaterThan(REQUEST_BUDGET_TOKENS);
  });

  it("counts the query in every chunk, so a long query makes chunks smaller", () => {
    for (const make of [typicalBookmark, shortBookmark]) {
      const bookmarks = collection(1000, make);
      const withShortQuery = chunked(bookmarks, "both", "vite");
      const withLongQuery = chunked(bookmarks, "both", worst(SEARCH_QUERY_CAP));
      expect(withShortQuery.length).toBeGreaterThan(1);
      expect(withLongQuery.length).toBeGreaterThanOrEqual(withShortQuery.length);
      // Every chunk but the last is full, and each is smaller with the long query.
      for (const [index, chunk] of withLongQuery.slice(0, -1).entries()) {
        expect(chunk.length).toBeLessThan(withShortQuery[index]!.length);
      }
    }
  });

  // The questions compete with the state for the 64k budget, and with one question asked, each
  // bookmark's share of it is smaller. Where the 32k budget limits a chunk instead, as for long
  // bookmarks, the room that one question gives back is only the difference between the longest
  // questions, so a chunk is at least as large.
  it("fits more bookmarks into a chunk when only one question is asked", () => {
    const short = collection(1000, shortBookmark);
    const both = chunked(short, "both");
    for (const one of ["noul", "score"] as const) {
      const single = chunked(short, one);
      expect(single.length).toBeLessThan(both.length);
      expect(single[0]!.length).toBeGreaterThan(both[0]!.length);
    }
    const typical = collection(1000, typicalBookmark);
    const typicalBoth = chunked(typical, "both");
    for (const one of ["noul", "score"] as const) {
      expect(chunked(typical, one)[0]!.length).toBeGreaterThanOrEqual(typicalBoth[0]!.length);
    }
  });

  // A `match_text` reaches about 2,000 characters at every cap, and the query 500, which is far
  // below the 32k budget, so the chunker never meets a bookmark that fits no chunk. A change to
  // a cap that broke this would fail here, not in production.
  it("fits the longest allowed bookmark, with the longest query, in one chunk", () => {
    const ask: SearchAsk = {
      query: worst(SEARCH_QUERY_CAP),
      bookmarks: [longestBookmark("longest")],
      questions: "both",
    };
    expect(fits(ask)).toBe(true);
    expect(chunkBookmarks(ask)).toEqual([ask.bookmarks]);
  });

  it("refuses a bookmark that fits no chunk, which the caps rule out", () => {
    const tooLong: SearchBookmark = {
      id: "too-long",
      title: "Too long",
      kind: "tool",
      matchText: worst(STATE_BUDGET_TOKENS),
    };
    expect(() => chunked([tooLong])).toThrow(RangeError);
  });

  it("makes no chunk for no bookmarks", () => {
    expect(chunked([])).toEqual([]);
  });
});
