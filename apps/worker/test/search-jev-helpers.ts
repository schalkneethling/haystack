// What the tests of searching a whole collection share (#211, #213): the Jev configuration, the
// bookmarks, and resolvers for the Jev fixture that answer every question the request asks. Each
// bookmark's title is its ID and its Noul is its number divided by 1,000, so a resolver can tell
// which bookmarks a request is about, and a test can tell which answer is whose.
import { HttpResponse } from "msw";
import type { JevConfig, JevTiming } from "../src/enrichment/jev-client.ts";
import { JevLimiter } from "../src/search/jev-limiter.ts";
import {
  SEARCH_TIMING,
  type SearchBookmark,
  type SearchQuestions,
} from "../src/search/jev-search.ts";
import { JEV_ORIGIN, type JevResolver } from "./jev-fixture.ts";

export const config: JevConfig = {
  JEV_BASE_URL: JEV_ORIGIN,
  JEV_MODEL: "jev-1.14.0",
  TYPESAFE_API_KEY: "ts-chunked-search-key-91c4",
};

// SEARCH_TIMING with shorter waits, and its own attempt limit, so the retry tests expect the
// attempts that search makes.
export const timing: JevTiming = { ...SEARCH_TIMING, attemptTimeoutMs: 500, backoffInitialMs: 1 };

// A limiter that never holds a request back, for the tests that aren't about the limiter.
export function openLimiter(): JevLimiter {
  return new JevLimiter({ requestsPerSecond: 1_000_000, tokensPerSecond: 1_000_000_000 });
}

export const QUERY = "a test runner for a Vite project";

// Bookmarks with a `match_text` of 2,000 characters, the most one reaches at every cap, so that a
// few hundred of them make several chunks. Each one's title is its ID, so a resolver can tell
// which bookmarks a request is about.
export function collection(size: number, prefix = "bookmark"): SearchBookmark[] {
  return Array.from({ length: size }, (_, index) => {
    const id = `${prefix}-${index}`;
    return { id, title: id, kind: "tool", matchText: "x".repeat(2000) };
  });
}

export function ids(bookmarks: readonly SearchBookmark[]): string[] {
  return bookmarks.map(({ id }) => id);
}

export interface SentBody {
  readonly state: { readonly bookmarks: Record<string, { readonly title: string }> };
  readonly questions: Record<string, { readonly type: string }>;
}

// The IDs of the bookmarks a request is about, from the titles in its state.
async function askedAbout(request: Request): Promise<string[]> {
  const body = (await request.clone().json()) as SentBody;
  return Object.values(body.state.bookmarks).map(({ title }) => title);
}

// A Noul for each bookmark that ranks them: bookmark-<n> gets n / 1000.
export function noulFor(id: string): number {
  return Number(id.split("-").at(-1)) / 1000;
}

export const RELEVANCE = {
  type: "score",
  score: 2.3,
  confidence: 0.41,
  probabilities: { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.6 },
};

/** Answers every question in the request, with `input_tokens` of 100 per bookmark. */
export const answerAll: JevResolver = async (request) => {
  const body = (await request.json()) as SentBody;
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(body.questions)) {
    const alias = id.replace(/_(helps|relevance)$/u, "");
    const title = body.state.bookmarks[alias]?.title ?? "";
    answers[id] = question.type === "noul" ? { type: "noul", noul: noulFor(title) } : RELEVANCE;
  }
  return HttpResponse.json({
    model: "jev-1.14.0",
    answers,
    usage: { input_tokens: 100 * Object.keys(body.state.bookmarks).length, output_tokens: 5 },
  });
};

/** `answerAll`, unless `refuse` says otherwise for the bookmarks the request is about. */
export function answerUnless(refuse: (bookmarkIds: string[]) => Response | undefined): JevResolver {
  return async (request) => refuse(await askedAbout(request)) ?? answerAll(request);
}

export function expectedAnswer(id: string, questions: SearchQuestions = "both") {
  return {
    bookmarkId: id,
    noul: questions === "score" ? null : noulFor(id),
    score:
      questions === "noul"
        ? null
        : { score: RELEVANCE.score, probabilities: RELEVANCE.probabilities, confidence: 0.41 },
  };
}
