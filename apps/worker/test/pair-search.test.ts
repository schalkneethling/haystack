// Pair mode (#213): one request for each bookmark, with the query and that one bookmark in the
// state, sent through the same limiter and concurrency limit as batched mode, and returning the
// same shape. Every request is answered by the Jev fixture (jev-fixture.ts), which fails a test
// that makes a request it did not plan for, so no test calls TypeSafe. See "Request modes" and
// "When Jev fails" in plans/haystack-v1-implementation-plan.md.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { HttpResponse } from "msw";
import { searchInChunks } from "../src/search/chunked-search.ts";
import { SEARCH_JEV_CONCURRENCY } from "../src/search/concurrency.ts";
import { JevLimiter, SEARCH_JEV_LIMITS } from "../src/search/jev-limiter.ts";
import { searchInPairs } from "../src/search/pair-search.ts";
import { fakeClock } from "./fake-clock.ts";
import { type JevFixture, type JevResolver, startJevFixture, status } from "./jev-fixture.ts";
import {
  answerAll,
  answerUnless,
  collection,
  config,
  expectedAnswer,
  ids,
  noulFor,
  openLimiter,
  QUERY,
  RELEVANCE,
  type SentBody,
  timing,
} from "./search-jev-helpers.ts";

let fixture: JevFixture;

beforeAll(() => {
  fixture = startJevFixture();
});

afterAll(() => {
  fixture.close();
});

beforeEach(() => {
  fixture.reset();
});

afterEach(() => {
  expect(fixture.unplanned).toEqual([]);
  vi.restoreAllMocks();
});

// Queues `count` copies of `resolver`, for a test that doesn't know the order of its requests.
function respondEach(resolver: JevResolver, count: number): void {
  fixture.respond(...Array<JevResolver>(count).fill(resolver));
}

interface SentRequest extends SentBody {
  readonly state: SentBody["state"] & { readonly query: string };
  readonly questions: Record<string, { readonly type: string; readonly instructions: string }>;
}

function sentRequests(): SentRequest[] {
  return fixture.requests.map(({ body }) => JSON.parse(body) as SentRequest);
}

describe("searchInPairs", () => {
  it("sends one request for each bookmark, each with the query and that one bookmark", async () => {
    const bookmarks = collection(7);
    respondEach(answerAll, bookmarks.length);
    await searchInPairs(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter: openLimiter(), timing },
    );
    const requests = sentRequests();
    expect(requests).toHaveLength(bookmarks.length);
    for (const request of requests) {
      expect(request.state.query).toBe(QUERY);
      expect(Object.keys(request.state.bookmarks)).toHaveLength(1);
    }
    // Every bookmark is in exactly one request.
    expect(
      requests
        .flatMap(({ state }) => Object.values(state.bookmarks).map(({ title }) => title))
        .toSorted(),
    ).toEqual(ids(bookmarks).toSorted());
  });

  it("asks the questions that batched mode asks, with the same wording", async () => {
    const bookmarks = collection(2);
    respondEach(answerAll, 3);
    await searchInChunks(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter: openLimiter(), timing },
    );
    await searchInPairs(
      config,
      { query: QUERY, bookmarks: bookmarks.slice(1), questions: "both" },
      { limiter: openLimiter(), timing },
    );
    const requests = sentRequests();
    expect(requests).toHaveLength(2);
    const [batched, pair] = requests as [SentRequest, SentRequest];
    // The batched request holds the bookmarks as b_0 and b_1, and the pair request holds the
    // second one as b_0, so the alias is the only text that may differ.
    const secondInBatch = Object.fromEntries(
      Object.entries(batched.questions).filter(([id]) => id.startsWith("b_1_")),
    );
    expect(Object.keys(pair.questions).toSorted()).toEqual(["b_0_helps", "b_0_relevance"]);
    expect(JSON.stringify(pair.questions)).toEqual(
      JSON.stringify(secondInBatch).replaceAll("b_1", "b_0"),
    );
  });

  it("asks only the question it is told to", async () => {
    const bookmarks = collection(3);
    for (const questions of ["noul", "score"] as const) {
      fixture.reset();
      respondEach(answerAll, bookmarks.length);
      const result = await searchInPairs(
        config,
        { query: QUERY, bookmarks, questions },
        { limiter: openLimiter(), timing },
      );
      expect(result.answers).toEqual(ids(bookmarks).map((id) => expectedAnswer(id, questions)));
    }
  });

  it("refuses a bookmark given twice before anything is sent", async () => {
    const bookmarks = collection(3);
    await expect(
      searchInPairs(
        config,
        { query: QUERY, bookmarks: [...bookmarks, bookmarks[0]!], questions: "both" },
        { limiter: openLimiter(), timing },
      ),
    ).rejects.toThrow(RangeError);
    expect(fixture.requests).toEqual([]);
  });

  it("sums usage.input_tokens across the requests", async () => {
    const bookmarks = collection(5);
    // Bookmark-<n>'s request reports 10 * (n + 1) input tokens: 10, 20, 30, 40 and 50.
    respondEach(async (request) => {
      const response = await answerAll(request.clone());
      const body = (await response.json()) as Record<string, unknown>;
      const title = Object.values(((await request.json()) as SentBody).state.bookmarks)[0]!.title;
      const n = Number(title.split("-").at(-1));
      return HttpResponse.json({
        ...body,
        usage: { input_tokens: 10 * (n + 1), output_tokens: 5 },
      });
    }, bookmarks.length);
    const result = await searchInPairs(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter: openLimiter(), timing },
    );
    expect(result.inputTokens).toBe(150);
  });

  it("returns every answer in the order given, whichever request answers first", async () => {
    const bookmarks = collection(6);
    // The first request answers last, so the order the answers arrive in isn't the order given.
    let first = true;
    respondEach(async (request) => {
      if (first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return answerAll(request);
    }, bookmarks.length);
    const result = await searchInPairs(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter: openLimiter(), timing: { ...timing, attemptTimeoutMs: 5000 } },
    );
    expect(result.answers.map(({ bookmarkId }) => bookmarkId)).toEqual(ids(bookmarks));
  });

  it("sends every request through the limiter, none of them early", async () => {
    const clock = fakeClock();
    // Five requests a second, so 12 requests take until the third second.
    const limiter = new JevLimiter({ ...SEARCH_JEV_LIMITS, requestsPerSecond: 5 }, clock);
    const bookmarks = collection(12);
    const arrivals: number[] = [];
    respondEach((request) => {
      arrivals.push(clock.now());
      return answerAll(request);
    }, bookmarks.length);
    const search = searchInPairs(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter, timing },
    );
    for (const sent of [5, 10, 12]) {
      await vi.waitFor(() => {
        expect(arrivals).toHaveLength(sent);
      });
      await clock.advance(1000);
    }
    expect((await search).outcome).toBe("ok");
    expect(arrivals).toEqual([0, 0, 0, 0, 0, 1000, 1000, 1000, 1000, 1000, 2000, 2000]);
  });

  it("has more than one request in flight at once, and never more than its constant", async () => {
    expect(SEARCH_JEV_CONCURRENCY).toBeGreaterThan(1);
    const bookmarks = collection(SEARCH_JEV_CONCURRENCY * 3);
    let inFlight = 0;
    let most = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    respondEach(async (request) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await held;
      inFlight -= 1;
      return answerAll(request);
    }, bookmarks.length);
    const search = searchInPairs(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter: openLimiter(), timing: { ...timing, attemptTimeoutMs: 5000 } },
    );
    await vi.waitFor(() => {
      expect(inFlight).toBe(SEARCH_JEV_CONCURRENCY);
    });
    release();
    expect((await search).outcome).toBe("ok");
    expect(most).toBe(SEARCH_JEV_CONCURRENCY);
    expect(fixture.requests).toHaveLength(bookmarks.length);
  });

  describe("when Jev fails", () => {
    it("keeps the answers of the requests that succeeded, and names the bookmark it didn't answer", async () => {
      const bookmarks = collection(5);
      // bookmark-2's request fails each of its 3 attempts with a 503, which is retried.
      respondEach(
        answerUnless((asked) =>
          asked[0] === "bookmark-2" ? HttpResponse.json({}, { status: 503 }) : undefined,
        ),
        bookmarks.length + 2,
      );
      const result = await searchInPairs(
        config,
        { query: QUERY, bookmarks, questions: "both" },
        { limiter: openLimiter(), timing },
      );
      expect(result).toEqual({
        outcome: "partial",
        answers: ["bookmark-0", "bookmark-1", "bookmark-3", "bookmark-4"].map((id) =>
          expectedAnswer(id),
        ),
        unanswered: ["bookmark-2"],
        failures: [
          {
            bookmarkIds: ["bookmark-2"],
            failure: {
              ok: false,
              failure: "transient",
              reason: "status",
              status: 503,
              attempts: 3,
            },
          },
        ],
        models: ["jev-1.14.0"],
        inputTokens: 400,
        attempts: bookmarks.length + 2,
      });
    });

    it("returns no answers when every request fails, and says so", async () => {
      const bookmarks = collection(4);
      respondEach(status(503), bookmarks.length * 3);
      const result = await searchInPairs(
        config,
        { query: QUERY, bookmarks, questions: "both" },
        { limiter: openLimiter(), timing },
      );
      expect(result).toMatchObject({
        outcome: "failed",
        answers: [],
        unanswered: ids(bookmarks),
        models: [],
        inputTokens: 0,
        attempts: bookmarks.length * 3,
      });
      expect(result.failures.map(({ bookmarkIds }) => bookmarkIds)).toEqual(
        bookmarks.map(({ id }) => [id]),
      );
    });

    it("doesn't split a request that Jev finds too long, because a bookmark can't be split", async () => {
      const bookmarks = collection(2);
      respondEach(
        () => HttpResponse.json({ detail: "max_tokens_exceeded: too long" }, { status: 400 }),
        2,
      );
      const result = await searchInPairs(
        config,
        { query: QUERY, bookmarks, questions: "both" },
        { limiter: openLimiter(), timing },
      );
      expect(result).toMatchObject({ outcome: "failed", unanswered: ids(bookmarks), attempts: 2 });
      expect(fixture.requests).toHaveLength(2);
    });
  });

  // #212 ends a search at a deadline with a signal. A bookmark whose request hasn't been sent by
  // then is unanswered, as a chunk is in batched mode.
  it("keeps the answers it has when its signal ends it, and lists the rest as unanswered", async () => {
    const clock = fakeClock();
    const limiter = new JevLimiter({ ...SEARCH_JEV_LIMITS, requestsPerSecond: 1 }, clock);
    const bookmarks = collection(3);
    let answered = 0;
    fixture.respond(async (request) => {
      const response = await answerAll(request);
      answered += 1;
      return response;
    });
    const deadline = new AbortController();
    const search = searchInPairs(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter, timing, signal: deadline.signal },
    );
    await vi.waitFor(() => {
      expect(answered).toBe(1);
    });
    await clock.advance(500);
    deadline.abort(new Error("The search's deadline passed"));
    const result = await search;
    expect(result).toEqual({
      outcome: "partial",
      answers: [expectedAnswer("bookmark-0")],
      unanswered: ["bookmark-1", "bookmark-2"],
      failures: [
        { bookmarkIds: ["bookmark-1"], failure: { ok: false, reason: "aborted", attempts: 0 } },
        { bookmarkIds: ["bookmark-2"], failure: { ok: false, reason: "aborted", attempts: 0 } },
      ],
      models: ["jev-1.14.0"],
      inputTokens: 100,
      attempts: 1,
    });
    expect(JSON.stringify(result.failures)).not.toContain(QUERY);
    expect(fixture.requests).toHaveLength(1);
  });

  it("sends nothing for an empty collection, and says every bookmark was answered", async () => {
    await expect(
      searchInPairs(config, { query: QUERY, bookmarks: [], questions: "both" }, { timing }),
    ).resolves.toEqual({
      outcome: "ok",
      answers: [],
      unanswered: [],
      failures: [],
      models: [],
      inputTokens: 0,
      attempts: 0,
    });
    expect(fixture.requests).toEqual([]);
  });
});

// The service doesn't care which mode ran, so both modes return the same shape. Each mode makes
// as many requests as it needs, and one suite checks what comes back.
describe.each([
  ["batched", searchInChunks, 1],
  ["pair", searchInPairs, 5],
] as const)("the result of %s mode", (_mode, search, requestsFor5) => {
  const bookmarks = collection(5);
  const run = (resolvers: number) => {
    respondEach(answerAll, resolvers);
    return search(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter: openLimiter(), timing },
    );
  };

  it("has the same fields, with every answer in the order given", async () => {
    const result = await run(requestsFor5);
    expect(result).toEqual({
      outcome: "ok",
      answers: ids(bookmarks).map((id) => expectedAnswer(id)),
      unanswered: [],
      failures: [],
      models: ["jev-1.14.0"],
      inputTokens: 500,
      attempts: requestsFor5,
    });
    expect(RELEVANCE.score).toBeGreaterThan(noulFor("bookmark-0"));
  });

  it("is failed, with no answers and every bookmark unanswered, when nothing is answered", async () => {
    respondEach(status(503), 15);
    const result = await search(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter: openLimiter(), timing },
    );
    expect(result).toMatchObject({
      outcome: "failed",
      answers: [],
      unanswered: ids(bookmarks),
      models: [],
      inputTokens: 0,
    });
    expect(Object.keys(result).toSorted()).toEqual([
      "answers",
      "attempts",
      "failures",
      "inputTokens",
      "models",
      "outcome",
      "unanswered",
    ]);
  });
});
