// Answers the search page's requests to /api/search in the browser, with `page.route`, as
// held-lookups.ts holds the address form's lookups (#105). The real route answers no search until
// #214, and the stub lives here rather than in the Worker, because a path that only tests use
// does not belong in production code (plan, "Testing strategy"). Every answer is checked against
// the web answer's schema first, so the page is tested against the shape the real route will
// give.
import { SearchAnswer } from "@haystack/schemas";
import { expect, type Page, type Request, type Route } from "@playwright/test";
import * as v from "valibot";

/** What search.js says in the page's live region. */
export const SEARCH_MESSAGES = {
  empty: "Type what you're looking for, then press Search.",
  processing: "Searching your saved links. This can take a few seconds.",
  none: "No saved links match your search.",
  one: "1 saved link matches your search.",
  noneSearched: "None of the links that could be searched match your search.",
  incomplete:
    "Some of your links could not be searched, so there may be more matches. You can press Search to try again.",
  timeout: "Searching your saved links took too long.",
  network: "Haystack could not be reached. Check your connection, then try again.",
  failed: "Something went wrong, so your links could not be searched.",
  signedOut: "You are signed out, so your links could not be searched. Sign in again",
} as const;

/** The Search button's label while a search runs. */
export const SEARCH_PROCESSING_LABEL = "Processing…";

/** The button in the error state that sends the failed query again. */
export const TRY_AGAIN = "Try again";

/** One result, as a test describes it. */
export interface StubbedResult {
  readonly title: string;
  readonly description?: string | null;
  readonly url?: string;
}

/** Whether every link was searched, as the answer says it. */
export type SearchOutcome = SearchAnswer["outcome"];

/**
 * An answer of 200 with these results, in this order, and the outcome `ok`; the same with the
 * outcome given; or another status with no body.
 */
export type StubbedAnswer =
  | readonly StubbedResult[]
  | { readonly results: readonly StubbedResult[]; readonly outcome: SearchOutcome }
  | { readonly status: number };

export interface SearchRequest {
  readonly request: Request;
  /** The body the page sent, parsed as JSON. */
  readonly body: unknown;
}

/** The page's live region, which holds the count and the other messages. */
export const SEARCH_STATUS = "#list-status";

let nextId = 0;

/** The answer's own form of a test's results, checked against the schema. */
export function searchAnswer(
  results: readonly StubbedResult[],
  outcome: SearchOutcome = "ok",
): SearchAnswer {
  return v.parse(SearchAnswer, {
    runId: `run-${(nextId += 1)}`,
    outcome,
    results: results.map(({ title, description = null, url }, index) => ({
      id: `result-${nextId}-${index}`,
      title,
      description,
      url: url ?? `https://example.com/${encodeURIComponent(title)}`,
    })),
  });
}

function queryIn(body: unknown): string {
  return typeof body === "object" && body !== null && "query" in body ? String(body.query) : "";
}

function fulfil(route: Route, reply: StubbedAnswer): Promise<void> {
  if ("status" in reply) {
    return route.fulfill({ status: reply.status });
  }
  const answer =
    "outcome" in reply ? searchAnswer(reply.results, reply.outcome) : searchAnswer(reply);
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(answer),
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
    await fulfil(route, answer(queryIn(body)));
  });
  return requests;
}

/** A search the page sent, which waits for the test to answer it. */
export interface HeldSearch {
  /** The query the page sent. */
  readonly query: string;
  readonly request: Request;
  /** Whether the browser gave up on the request, as it does when the script aborts it. */
  aborted(): boolean;
  /** Answers the request. */
  answer(reply: StubbedAnswer): Promise<void>;
  /** Fails the request, as a network error does. */
  fail(): Promise<void>;
}

export interface HeldSearches {
  /** Every search the page has sent since `holdSearches`, in order. */
  readonly all: readonly HeldSearch[];
  /** Waits for the next search, the `count`th since `holdSearches`. */
  next(count: number): Promise<HeldSearch>;
}

// A route the browser has already given up on cannot be answered, and that is not the test's
// concern, so the error is dropped.
async function settle(action: () => Promise<void>): Promise<void> {
  await action().catch(() => undefined);
}

/**
 * Holds every search the page sends until the test answers it, so a test can look at a search
 * while it runs (#207), then decide each answer.
 */
export async function holdSearches(page: Page): Promise<HeldSearches> {
  const all: HeldSearch[] = [];
  const failed = new Set<Request>();
  page.on("requestfailed", (request) => {
    failed.add(request);
  });
  await page.route("**/api/search", (route) => {
    const request = route.request();
    all.push({
      query: queryIn(request.postDataJSON()),
      request,
      aborted: () => failed.has(request),
      answer: (reply) => settle(() => fulfil(route, reply)),
      fail: () => settle(() => route.abort("failed")),
    });
  });
  return {
    all,
    next: async (count) => {
      await expect.poll(() => all.length, `search ${count} is sent`).toBeGreaterThanOrEqual(count);
      const search = all[count - 1];
      if (search === undefined) {
        throw new Error(`There is no search ${count}`);
      }
      return search;
    },
  };
}
