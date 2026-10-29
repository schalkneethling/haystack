// Answers the search page's requests to /api/search in the browser, with `page.route`, as
// held-lookups.ts holds the address form's lookups (#105). The real route answers no search until
// #214, and the stub lives here rather than in the Worker, because a path that only tests use
// does not belong in production code (plan, "Testing strategy"). Every answer is checked against
// the web answer's schema first, so the page is tested against the shape the real route will
// give.
import { SearchAnswer } from "@haystack/schemas";
import type { Page, Request } from "@playwright/test";
import * as v from "valibot";

/** What search.js says in the page's live region. */
export const SEARCH_MESSAGES = {
  empty: "Type what you're looking for, then press Search.",
  none: "No saved links match your search.",
  one: "1 saved link matches your search.",
  failed:
    "Something went wrong, so your links could not be searched. You can press Search to try again.",
  signedOut: "You are signed out, so your links could not be searched. Sign in again",
} as const;

/** One result, as a test describes it. */
export interface StubbedResult {
  readonly title: string;
  readonly description?: string | null;
  readonly url?: string;
}

/** An answer of 200 with these results, in this order, or another status with no body. */
export type StubbedAnswer = readonly StubbedResult[] | { readonly status: number };

export interface SearchRequest {
  readonly request: Request;
  /** The body the page sent, parsed as JSON. */
  readonly body: unknown;
}

/** The page's live region, which holds the count and the other messages. */
export const SEARCH_STATUS = "#list-status";

let nextId = 0;

/** The answer's own form of a test's results, checked against the schema. */
export function searchAnswer(results: readonly StubbedResult[]): SearchAnswer {
  return v.parse(SearchAnswer, {
    runId: `run-${(nextId += 1)}`,
    results: results.map(({ title, description = null, url }, index) => ({
      id: `result-${nextId}-${index}`,
      title,
      description,
      url: url ?? `https://example.com/${encodeURIComponent(title)}`,
    })),
  });
}

/**
 * Answers every search the page sends with `answer(query)`, and records each request. Returns
 * the requests, in order, which the test reads as they arrive.
 */
export async function answerSearches(
  page: Page,
  answer: (query: string) => StubbedAnswer,
): Promise<readonly SearchRequest[]> {
  const requests: SearchRequest[] = [];
  await page.route("**/api/search", async (route) => {
    const request = route.request();
    const body: unknown = request.postDataJSON();
    requests.push({ request, body });
    const query =
      typeof body === "object" && body !== null && "query" in body ? String(body.query) : "";
    const reply = answer(query);
    await ("status" in reply
      ? route.fulfill({ status: reply.status })
      : route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(searchAnswer(reply)),
        }));
  });
  return requests;
}
