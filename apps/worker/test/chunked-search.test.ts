// Asking Jev about a collection of any size (#211): the chunks, sent concurrently through the
// limiter; a chunk that Jev finds too long, split and asked again; and which bookmarks a failure
// leaves unanswered. Every request is answered by the Jev fixture (jev-fixture.ts), which fails a
// test that makes a request it did not plan for, so no test calls TypeSafe. See "Jev model
// limits", "Request modes" and "When Jev fails" in plans/haystack-v1-implementation-plan.md.
import { HttpResponse } from "msw";
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
import type { JevConfig, JevTiming } from "../src/enrichment/jev-client.ts";
import { searchInChunks } from "../src/search/chunked-search.ts";
import { SEARCH_JEV_CONCURRENCY } from "../src/search/concurrency.ts";
import { JevLimiter, SEARCH_JEV_LIMITS } from "../src/search/jev-limiter.ts";
import {
  SEARCH_TIMING,
  type SearchBookmark,
  type SearchQuestions,
} from "../src/search/jev-search.ts";
import { chunkBookmarks } from "../src/search/search-chunks.ts";
import { fakeClock } from "./fake-clock.ts";
import {
  JEV_ORIGIN,
  type JevFixture,
  type JevResolver,
  startJevFixture,
  status,
} from "./jev-fixture.ts";

const config: JevConfig = {
  JEV_BASE_URL: JEV_ORIGIN,
  JEV_MODEL: "jev-1.14.0",
  TYPESAFE_API_KEY: "ts-chunked-search-key-91c4",
};

// SEARCH_TIMING with shorter waits, and its own attempt limit, so the retry tests expect the
// attempts that search makes.
const timing: JevTiming = { ...SEARCH_TIMING, attemptTimeoutMs: 500, backoffInitialMs: 1 };

// A limiter that never holds a request back, for the tests that aren't about the limiter.
function openLimiter(): JevLimiter {
  return new JevLimiter({ requestsPerSecond: 1_000_000, tokensPerSecond: 1_000_000_000 });
}

const QUERY = "a test runner for a Vite project";

// Bookmarks with a `match_text` of 2,000 characters, the most one reaches at every cap, so that a
// few hundred of them make several chunks. Each one's title is its ID, so a resolver can tell
// which bookmarks a request is about.
function collection(size: number, prefix = "bookmark"): SearchBookmark[] {
  return Array.from({ length: size }, (_, index) => {
    const id = `${prefix}-${index}`;
    return { id, title: id, kind: "tool", matchText: "x".repeat(2000) };
  });
}

function ids(bookmarks: readonly SearchBookmark[]): string[] {
  return bookmarks.map(({ id }) => id);
}

interface SentBody {
  readonly state: { readonly bookmarks: Record<string, { readonly title: string }> };
  readonly questions: Record<string, { readonly type: string }>;
}

// The IDs of the bookmarks a request is about, from the titles in its state.
async function askedAbout(request: Request): Promise<string[]> {
  const body = (await request.clone().json()) as SentBody;
  return Object.values(body.state.bookmarks).map(({ title }) => title);
}

function askedIn(index: number): Promise<string[]> {
  const body = JSON.parse(fixture.requests[index]?.body ?? "") as SentBody;
  return Promise.resolve(Object.values(body.state.bookmarks).map(({ title }) => title));
}

// A Noul for each bookmark that ranks them: bookmark-<n> gets n / 1000.
function noulFor(id: string): number {
  return Number(id.split("-").at(-1)) / 1000;
}

const RELEVANCE = {
  type: "score",
  score: 2.3,
  confidence: 0.41,
  probabilities: { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.6 },
};

/** Answers every question in the request, with `input_tokens` of 100 per bookmark. */
const answerAll: JevResolver = async (request) => {
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
function answerUnless(refuse: (bookmarkIds: string[]) => Response | undefined): JevResolver {
  return async (request) => refuse(await askedAbout(request)) ?? answerAll(request);
}

/** A `400` that says the request is longer than the model's context length. */
function tooLong(): Response {
  return HttpResponse.json(
    { detail: "max_tokens_exceeded: the request is longer than the model's context length" },
    { status: 400 },
  );
}

// Queues `count` copies of `resolver`, for a test that doesn't know the order of its requests.
function respondEach(resolver: JevResolver, count: number): void {
  fixture.respond(...Array<JevResolver>(count).fill(resolver));
}

function expectedAnswer(id: string, questions: SearchQuestions = "both") {
  return {
    bookmarkId: id,
    noul: questions === "score" ? null : noulFor(id),
    score:
      questions === "noul"
        ? null
        : { score: RELEVANCE.score, probabilities: RELEVANCE.probabilities, confidence: 0.41 },
  };
}

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

describe("searchInChunks", () => {
  it("sends nothing for an empty collection, and says every bookmark was answered", async () => {
    await expect(
      searchInChunks(config, { query: QUERY, bookmarks: [], questions: "both" }, { timing }),
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

  it("sends one request per chunk, and returns every answer in the order given", async () => {
    const bookmarks = collection(200);
    const chunks = chunkBookmarks({ query: QUERY, bookmarks, questions: "both" });
    expect(chunks.length).toBeGreaterThan(2);
    respondEach(answerAll, chunks.length);
    const result = await searchInChunks(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter: openLimiter(), timing },
    );
    expect(result).toEqual({
      outcome: "ok",
      answers: ids(bookmarks).map((id) => expectedAnswer(id)),
      unanswered: [],
      failures: [],
      models: ["jev-1.14.0"],
      // The fixture reports 100 input tokens per bookmark, so the sum covers every chunk.
      inputTokens: 100 * bookmarks.length,
      attempts: chunks.length,
    });
    // Each request is about exactly one chunk's bookmarks.
    const asked = await Promise.all(chunks.map((_, index) => askedIn(index)));
    expect(asked.map((chunk) => chunk.join()).toSorted()).toEqual(
      chunks.map((chunk) => ids(chunk).join()).toSorted(),
    );
  });

  describe("a chunk that Jev finds too long", () => {
    it("is split in half, and the halves' answers are combined", async () => {
      const bookmarks = collection(4);
      // The four fit one chunk by the estimate, and Jev refuses that chunk once.
      expect(chunkBookmarks({ query: QUERY, bookmarks, questions: "both" })).toHaveLength(1);
      fixture.respond(() => tooLong(), answerAll, answerAll);
      const result = await searchInChunks(
        config,
        { query: QUERY, bookmarks, questions: "both" },
        { limiter: openLimiter(), timing },
      );
      expect(result).toMatchObject({
        outcome: "ok",
        answers: ids(bookmarks).map((id) => expectedAnswer(id)),
        unanswered: [],
        failures: [],
        inputTokens: 400,
        attempts: 3,
      });
      expect(await Promise.all([0, 1, 2].map(askedIn))).toEqual([
        ids(bookmarks),
        ids(bookmarks.slice(0, 2)),
        ids(bookmarks.slice(2)),
      ]);
    });

    it("is split again while a half is still too long, down to one bookmark", async () => {
      const bookmarks = collection(4);
      // Jev refuses any request about more than one bookmark, and the last one even alone.
      respondEach(
        answerUnless((asked) =>
          asked.length > 1 || asked[0] === "bookmark-3" ? tooLong() : undefined,
        ),
        7,
      );
      const result = await searchInChunks(
        config,
        { query: QUERY, bookmarks, questions: "both" },
        { limiter: openLimiter(), timing },
      );
      expect(result).toMatchObject({
        outcome: "partial",
        answers: ids(bookmarks.slice(0, 3)).map((id) => expectedAnswer(id)),
        unanswered: ["bookmark-3"],
        failures: [
          {
            bookmarkIds: ["bookmark-3"],
            failure: { status: 400, code: "max_tokens_exceeded", attempts: 1 },
          },
        ],
      });
      // 4, then 2 and 2, then 1, 1, 1 and 1.
      expect(fixture.requests).toHaveLength(7);
    });

    // A 413 means only that the body is over 32 MiB, not that the request is longer than the
    // model's context, so splitting isn't the answer to it.
    it("is not what a 413 is", async () => {
      const bookmarks = collection(4);
      fixture.respond(() => HttpResponse.json({ detail: "max_tokens_exceeded" }, { status: 413 }));
      const result = await searchInChunks(
        config,
        { query: QUERY, bookmarks, questions: "both" },
        { limiter: openLimiter(), timing },
      );
      expect(result).toMatchObject({ outcome: "failed", unanswered: ids(bookmarks) });
      expect(fixture.requests).toHaveLength(1);
    });
  });

  describe("when Jev fails", () => {
    it("keeps the answers of the chunks that succeeded, and names every bookmark it didn't answer", async () => {
      const bookmarks = collection(200);
      const chunks = chunkBookmarks({ query: QUERY, bookmarks, questions: "both" });
      const failing = chunks[1]!;
      // The second chunk's request fails each of its 3 attempts with a 503, which is retried.
      respondEach(
        answerUnless((asked) =>
          asked[0] === failing[0]?.id ? HttpResponse.json({}, { status: 503 }) : undefined,
        ),
        chunks.length + 2,
      );
      const result = await searchInChunks(
        config,
        { query: QUERY, bookmarks, questions: "both" },
        { limiter: openLimiter(), timing },
      );
      const answered = bookmarks.filter((bookmark) => !failing.includes(bookmark));
      expect(result).toEqual({
        outcome: "partial",
        answers: ids(answered).map((id) => expectedAnswer(id)),
        unanswered: ids(failing),
        failures: [
          {
            bookmarkIds: ids(failing),
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
        inputTokens: 100 * answered.length,
        attempts: chunks.length + 2,
      });
    });

    it("returns no answers when every chunk fails, and says so", async () => {
      const bookmarks = collection(200);
      const chunks = chunkBookmarks({ query: QUERY, bookmarks, questions: "both" });
      respondEach(status(503), chunks.length * 3);
      const result = await searchInChunks(
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
      expect(result.failures.map(({ bookmarkIds }) => bookmarkIds)).toEqual(
        chunks.map((chunk) => ids(chunk)),
      );
    });

    // A response that leaves out an answer gets the same answer again, as #210 found, and its
    // size isn't the problem, so it is a failed chunk rather than one to split.
    it("doesn't split a chunk whose response is invalid", async () => {
      const bookmarks = collection(4);
      fixture.respond(() =>
        HttpResponse.json({ model: "jev-1.14.0", answers: {}, usage: { input_tokens: 9 } }),
      );
      const result = await searchInChunks(
        config,
        { query: QUERY, bookmarks, questions: "both" },
        { limiter: openLimiter(), timing },
      );
      expect(result).toMatchObject({
        outcome: "failed",
        unanswered: ids(bookmarks),
        failures: [{ failure: { reason: "invalid-response" } }],
      });
      expect(fixture.requests).toHaveLength(1);
    });
  });

  // A chunk's own request refuses an ID given twice (#210), but two copies in different chunks
  // would each get an answer, which couldn't be told apart.
  it("refuses a bookmark given twice, even in different chunks, before anything is sent", async () => {
    const bookmarks = collection(200);
    await expect(
      searchInChunks(
        config,
        { query: QUERY, bookmarks: [...bookmarks, bookmarks[0]!], questions: "both" },
        { limiter: openLimiter(), timing },
      ),
    ).rejects.toThrow(RangeError);
    expect(fixture.requests).toEqual([]);
  });

  it("asks only the question it is told to, in every chunk", async () => {
    const bookmarks = collection(200);
    for (const questions of ["noul", "score"] as const) {
      fixture.reset();
      const chunks = chunkBookmarks({ query: QUERY, bookmarks, questions });
      respondEach(answerAll, chunks.length);
      const result = await searchInChunks(
        config,
        { query: QUERY, bookmarks, questions },
        { limiter: openLimiter(), timing },
      );
      expect(result.answers).toEqual(ids(bookmarks).map((id) => expectedAnswer(id, questions)));
    }
  });

  it("has more than one chunk in flight at once, and never more than its constant", async () => {
    expect(SEARCH_JEV_CONCURRENCY).toBeGreaterThan(1);
    const bookmarks = collection(600);
    const chunks = chunkBookmarks({ query: QUERY, bookmarks, questions: "both" });
    expect(chunks.length).toBeGreaterThan(SEARCH_JEV_CONCURRENCY * 2);
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
    }, chunks.length);
    const search = searchInChunks(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter: openLimiter(), timing: { ...timing, attemptTimeoutMs: 5000 } },
    );
    // Every response is held, so the requests in flight pile up to the limit and stop there.
    await vi.waitFor(() => {
      expect(inFlight).toBe(SEARCH_JEV_CONCURRENCY);
    });
    release();
    const result = await search;
    expect(result.outcome).toBe("ok");
    expect(most).toBe(SEARCH_JEV_CONCURRENCY);
    expect(fixture.requests).toHaveLength(chunks.length);
  });

  // #212 ends a search at a deadline with a signal. The chunks answered by then are kept, so the
  // run is `partial`, and each chunk not yet sent is a failure of its own, with a fixed reason.
  it("keeps the answers it has when its signal ends it, and lists the rest as unanswered", async () => {
    const clock = fakeClock();
    // One request a second, so the second and third chunks are still waiting at the deadline.
    const limiter = new JevLimiter({ ...SEARCH_JEV_LIMITS, requestsPerSecond: 1 }, clock);
    const bookmarks = collection(120);
    const chunks = chunkBookmarks({ query: QUERY, bookmarks, questions: "both" });
    expect(chunks.length).toBe(3);
    let answered = 0;
    fixture.respond(async (request) => {
      const response = await answerAll(request);
      answered += 1;
      return response;
    });
    const deadline = new AbortController();
    const search = searchInChunks(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter, timing, signal: deadline.signal },
    );
    await vi.waitFor(() => {
      expect(answered).toBe(1);
    });
    await clock.advance(500);
    deadline.abort(new Error("The search's deadline passed"));
    await expect(search).resolves.toMatchObject({ outcome: "partial" });
    const result = await search;
    const unsent = chunks.slice(1);
    expect(result).toEqual({
      outcome: "partial",
      answers: ids(chunks[0]!).map((id) => expectedAnswer(id)),
      unanswered: unsent.flatMap((chunk) => ids(chunk)),
      failures: unsent.map((chunk) => ({
        bookmarkIds: ids(chunk),
        failure: { ok: false, reason: "aborted", attempts: 0 },
      })),
      models: ["jev-1.14.0"],
      inputTokens: 100 * chunks[0]!.length,
      attempts: 1,
    });
    // The failures say nothing about the query.
    expect(JSON.stringify(result.failures)).not.toContain(QUERY);
    expect(fixture.requests).toHaveLength(1);
  });

  it("sends every chunk through the limiter it is given", async () => {
    const clock = fakeClock();
    // One request a second, so each chunk has to wait for the one before it.
    const limiter = new JevLimiter({ ...SEARCH_JEV_LIMITS, requestsPerSecond: 1 }, clock);
    const bookmarks = collection(120);
    const chunks = chunkBookmarks({ query: QUERY, bookmarks, questions: "both" });
    expect(chunks.length).toBe(3);
    const arrivals: number[] = [];
    respondEach((request) => {
      arrivals.push(clock.now());
      return answerAll(request);
    }, chunks.length);
    const search = searchInChunks(
      config,
      { query: QUERY, bookmarks, questions: "both" },
      { limiter, timing },
    );
    for (let sent = 1; sent <= chunks.length; sent += 1) {
      await vi.waitFor(() => {
        expect(arrivals).toHaveLength(sent);
      });
      await clock.advance(1000);
    }
    expect((await search).outcome).toBe("ok");
    expect(arrivals).toEqual([0, 1000, 2000]);
  });
});
