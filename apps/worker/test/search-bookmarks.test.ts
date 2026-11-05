// The search service (#212): which bookmarks are candidates, how a search asks Jev, ranks the
// answers and logs the run and every answer, and what it returns, against the real local D1 from
// Wrangler's test harness. Every request to Jev is answered by the Jev fixture (jev-fixture.ts),
// which fails a test that makes a request it did not plan for, so no test calls TypeSafe. The
// service is called from this process with plain values, as any channel would call it. See
// "Search design", "Ranking and thresholds" and "Enrichment state is derived, not stored" in
// plans/haystack-v1-implementation-plan.md.
import { readFile } from "node:fs/promises";
import { SEARCH_QUERY_CAP } from "@haystack/schemas";
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
import { createDb, type Db } from "../src/db/client.ts";
import type { JevConfig, JevTiming } from "../src/enrichment/jev-client.ts";
import { ENRICHMENT_SCHEMA_VERSION } from "../src/enrichment/enrichment-schema.ts";
import type { EnrichmentStatePolicy } from "../src/enrichment/state.ts";
import { SEARCH_SETTING_DEFAULTS, type SearchSettings } from "../src/flags.ts";
import { JevLimiter } from "../src/search/jev-limiter.ts";
import { SEARCH_TIMING } from "../src/search/jev-search.ts";
import {
  SEARCH_DEADLINE_MS,
  SEARCH_RESPONSE_MARGIN_MS,
  searchBookmarks,
  type SearchContext,
  type SearchSource,
} from "../src/search/search-bookmarks.ts";
import { writeSearchLog } from "../src/search/search-log.ts";
import { fakeClock } from "./fake-clock.ts";
import {
  JEV_ORIGIN,
  type JevFixture,
  type JevResolver,
  startJevFixture,
  status,
} from "./jev-fixture.ts";
import {
  seedBookmark,
  seedBookmarks,
  seedEnrichment,
  seedEnrichments,
  type SeededBookmarkFields,
  seedSignedInUser,
  type SeededUser,
} from "./seed.ts";
import { createTestWorker } from "./test-worker.ts";

const server = createTestWorker({
  vars: { ALLOWED_EMAILS: "owner@example.com, second@example.com" },
});

// The configured model differs from the one the fixture says answered, so a run shows which of
// the two it recorded.
const CONFIGURED_MODEL = "jev-latest";
const ANSWERING_MODEL = "jev-1.14.0";
const KEY = "ts-search-service-key-5b2e";

const jev: JevConfig = {
  JEV_BASE_URL: JEV_ORIGIN,
  JEV_MODEL: CONFIGURED_MODEL,
  TYPESAFE_API_KEY: KEY,
};

// SEARCH_TIMING with shorter waits, so the retry tests don't wait for real backoffs.
const timing: JevTiming = { ...SEARCH_TIMING, attemptTimeoutMs: 2000, backoffInitialMs: 1 };

const policy: EnrichmentStatePolicy = {
  schemaVersion: ENRICHMENT_SCHEMA_VERSION,
  sensitiveWarnThreshold: 0.5,
  attemptLimit: 3,
};

const OLDER_VERSION = ENRICHMENT_SCHEMA_VERSION - 1;

// A query that no fixed text contains, so finding it anywhere means it leaked.
const QUERY = "quokka-telescope-marmalade 7c41";

// Text in a response body that no fixed text contains.
const BODY_MARKER = "pangolin-body-marker-3e9d";

const WEB: SearchSource = { channel: "web", inputMode: "typed" };

// A limiter that never holds a request back, for the tests that aren't about the deadline.
function openLimiter(): JevLimiter {
  return new JevLimiter({ requestsPerSecond: 1_000_000, tokensPerSecond: 1_000_000_000 });
}

let fixture: JevFixture;
let db: Db;
let origin: string;
let owner: SeededUser;

async function d1() {
  return (await server.getWorker().getEnv()).DB;
}

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  db = createDb(await d1());
  fixture = startJevFixture();
});

afterAll(async () => {
  fixture.close();
  await server.close();
});

beforeEach(async () => {
  fixture.reset();
  const DB = await d1();
  // Runs first: a user who has runs can't be deleted, and deleting a run deletes its answers.
  await DB.batch([
    DB.prepare("DELETE FROM search_runs"),
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
  owner = await seedSignedInUser(DB, "owner@example.com");
});

afterEach(() => {
  expect(fixture.unplanned).toEqual([]);
  vi.restoreAllMocks();
});

function context(overrides: Partial<SearchContext> = {}): SearchContext {
  return {
    db,
    jev,
    settings: SEARCH_SETTING_DEFAULTS,
    policy,
    limiter: openLimiter(),
    timing,
    ...overrides,
  };
}

function search(
  overrides: Partial<SearchContext> = {},
  query = QUERY,
  source: SearchSource = WEB,
  userId = owner.userId,
) {
  return searchBookmarks(userId, query, source, context(overrides));
}

interface EnrichedFields extends SeededBookmarkFields {
  readonly schemaVersion?: number;
  readonly userId?: string;
}

/**
 * A bookmark with one enrichment, whose `match_text` is `matchText`, which the fixture's resolver
 * answers by. Its address is made from `matchText` too.
 */
async function saveEnriched(
  matchText: string,
  {
    schemaVersion = ENRICHMENT_SCHEMA_VERSION,
    userId = owner.userId,
    ...fields
  }: EnrichedFields = {},
): Promise<string> {
  const DB = await d1();
  const url = `https://example.com/${matchText}`;
  const id = await seedBookmark(DB, userId, url, url, { title: `Title ${matchText}`, ...fields });
  await seedEnrichment(DB, id, schemaVersion, { matchText, kind: "tool" });
  return id;
}

interface Signals {
  readonly noul: number;
  readonly score: number;
}

// Below both of the default thresholds, unless a test says otherwise.
const UNMATCHED: Signals = { noul: 0.1, score: 0.4 };

const PROBABILITIES = { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.6 };

interface SentBody {
  readonly model: string;
  readonly state: {
    readonly query: string;
    readonly bookmarks: Record<string, { readonly title: string; readonly match_text: string }>;
  };
  readonly questions: Record<string, { readonly type: string }>;
}

/**
 * Answers every question in the request, with each bookmark's signals from `signals`, by its
 * `match_text`, or UNMATCHED.
 */
function answerBy(signals: Record<string, Signals> = {}): JevResolver {
  return async (request) => {
    const body = (await request.json()) as SentBody;
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      const alias = id.replace(/_(helps|relevance)$/u, "");
      const matchText = body.state.bookmarks[alias]?.match_text ?? "";
      const { noul, score } = signals[matchText] ?? UNMATCHED;
      answers[id] =
        question.type === "noul"
          ? { type: "noul", noul }
          : { type: "score", score, confidence: 0.41, probabilities: PROBABILITIES };
    }
    return HttpResponse.json({
      model: ANSWERING_MODEL,
      answers,
      usage: { input_tokens: 100 * Object.keys(body.state.bookmarks).length, output_tokens: 5 },
    });
  };
}

// Queues `count` copies of `resolver`, for a test that doesn't know the order of its requests.
function respondEach(resolver: JevResolver, count: number): void {
  fixture.respond(...Array<JevResolver>(count).fill(resolver));
}

function sent(index = 0): SentBody {
  return JSON.parse(fixture.requests[index]?.body ?? "") as SentBody;
}

// The `match_text` of every bookmark the requests asked about, sorted.
function sentMatchTexts(): string[] {
  return fixture.requests
    .flatMap(({ body }) =>
      Object.values((JSON.parse(body) as SentBody).state.bookmarks).map(
        ({ match_text }) => match_text,
      ),
    )
    .toSorted();
}

interface RunRow {
  readonly id: string;
  readonly user_id: string;
  readonly query: string;
  readonly channel: string;
  readonly input_mode: string | null;
  readonly request_mode: string;
  readonly jev_model: string;
  readonly questions: string;
  readonly display_signal: string;
  readonly noul_threshold: number;
  readonly score_threshold: number;
  readonly input_tokens: number | null;
  readonly latency_ms: number | null;
  readonly outcome: string;
  readonly error: string | null;
  readonly created_at: number;
}

interface AnswerRow {
  readonly search_run_id: string;
  readonly bookmark_id: string;
  readonly noul: number | null;
  readonly score: number | null;
  readonly score_probabilities: string | null;
  readonly score_confidence: number | null;
  readonly shown: number;
  readonly clicked: number;
}

async function runs(): Promise<RunRow[]> {
  const { results } = await (
    await d1()
  )
    .prepare("SELECT * FROM search_runs ORDER BY created_at, rowid")
    .all();
  return results as RunRow[];
}

async function answerRows(runId?: string): Promise<AnswerRow[]> {
  const DB = await d1();
  const { results } = await (
    runId === undefined
      ? DB.prepare("SELECT * FROM search_answers ORDER BY rowid")
      : DB.prepare("SELECT * FROM search_answers WHERE search_run_id = ? ORDER BY rowid").bind(
          runId,
        )
  ).all();
  return results as AnswerRow[];
}

/**
 * 120 bookmarks with a `match_text` of 2,000 characters, so that they make several chunks, and
 * their IDs.
 */
async function seedSeveralChunks(): Promise<string[]> {
  const DB = await d1();
  const ids = await seedBookmarks(
    DB,
    owner.userId,
    Array.from({ length: 120 }, (_, index) => {
      const url = `https://example.com/${index}`;
      return { url, normalizedUrl: url, createdAt: index };
    }),
  );
  await seedEnrichments(
    DB,
    ids.map((bookmarkId, index) => ({
      bookmarkId,
      schemaVersion: ENRICHMENT_SCHEMA_VERSION,
      matchText: `${index} ${"x".repeat(2000)}`,
    })),
  );
  return ids;
}

// The IDs of the results, in their order.
function resultIds(result: { readonly results: readonly { readonly id: string }[] }): string[] {
  return result.results.map(({ id }) => id);
}

describe("searchBookmarks", () => {
  it("searches with plain values and no request object, and returns the shown results ranked", async () => {
    const DB = await d1();
    const url = "https://example.com/vitest";
    const first = await seedBookmark(DB, owner.userId, url, url, {
      title: "Vitest",
      description: "A test runner",
      createdAt: 1_000,
    });
    await seedEnrichment(DB, first, ENRICHMENT_SCHEMA_VERSION, { matchText: "first" });
    const second = await saveEnriched("second", { createdAt: 2_000 });
    await saveEnriched("below");
    fixture.respond(
      answerBy({ first: { noul: 0.6, score: 2.1 }, second: { noul: 0.9, score: 2.9 } }),
    );

    // The query is sent and stored as the caller gave it, around its spaces too, because Phase 12
    // joins its runs to its labeled queries by the exact text (plan, "The evaluation labels").
    const result = await search({}, `  ${QUERY} `);

    expect(result).toEqual({
      runId: expect.any(String),
      outcome: "ok",
      results: [
        {
          id: second,
          title: "Title second",
          description: null,
          url: "https://example.com/second",
          createdAt: 2_000,
        },
        { id: first, title: "Vitest", description: "A test runner", url, createdAt: 1_000 },
      ],
    });
    expect(fixture.requests).toHaveLength(1);
    expect(sent().state.query).toBe(QUERY);
    expect(sent().model).toBe(CONFIGURED_MODEL);
    const [run] = await runs();
    expect(run).toMatchObject({ id: result.runId, user_id: owner.userId, query: `  ${QUERY} ` });
  });

  it.each<[SearchSource, string | null]>([
    [{ channel: "web", inputMode: "typed" }, "typed"],
    [{ channel: "web", inputMode: "web-speech" }, "web-speech"],
    [{ channel: "webmcp" }, null],
    [{ channel: "mcp" }, null],
    [{ channel: "eval" }, null],
  ])(
    "records the channel of %o, and the input mode for the web only",
    async (source, inputMode) => {
      await saveEnriched("only");
      fixture.respond(answerBy());
      await search({}, QUERY, source);
      expect(await runs()).toEqual([
        expect.objectContaining({ channel: source.channel, input_mode: inputMode }),
      ]);
    },
  );

  it("logs every candidate that Jev answered, below the threshold too, with both signals", async () => {
    const shown = await saveEnriched("shown");
    const below = await saveEnriched("below");
    fixture.respond(answerBy({ shown: { noul: 0.7, score: 2.3 }, below: { noul: 0.2, score: 1 } }));
    const { runId } = await search();
    const answer = { search_run_id: runId, score_probabilities: JSON.stringify(PROBABILITIES) };
    expect(await answerRows(runId)).toEqual([
      {
        ...answer,
        bookmark_id: shown,
        noul: 0.7,
        score: 2.3,
        score_confidence: 0.41,
        shown: 1,
        clicked: 0,
      },
      {
        ...answer,
        bookmark_id: below,
        noul: 0.2,
        score: 1,
        score_confidence: 0.41,
        shown: 0,
        clicked: 0,
      },
    ]);
    expect(await runs()).toEqual([
      {
        id: runId,
        user_id: owner.userId,
        query: QUERY,
        channel: "web",
        input_mode: "typed",
        request_mode: "batched",
        jev_model: ANSWERING_MODEL,
        questions: "both",
        display_signal: "score",
        noul_threshold: 0.5,
        score_threshold: 1.5,
        // The fixture reports 100 input tokens per bookmark.
        input_tokens: 200,
        latency_ms: expect.any(Number),
        outcome: "ok",
        error: null,
        created_at: expect.any(Number),
      },
    ]);
  });

  it("logs answers in groups that fit D1's bound parameters, for a collection of 40", async () => {
    const DB = await d1();
    const ids = await seedBookmarks(
      DB,
      owner.userId,
      Array.from({ length: 40 }, (_, index) => {
        const url = `https://example.com/${index}`;
        return { url, normalizedUrl: url, createdAt: index };
      }),
    );
    await seedEnrichments(
      DB,
      ids.map((bookmarkId, index) => ({
        bookmarkId,
        schemaVersion: ENRICHMENT_SCHEMA_VERSION,
        matchText: `bookmark ${index}`,
      })),
    );
    fixture.respond(answerBy());
    const { runId, outcome } = await search();
    expect(outcome).toBe("ok");
    expect((await answerRows(runId)).map(({ bookmark_id }) => bookmark_id).toSorted()).toEqual(
      ids.toSorted(),
    );
  });

  it("takes its thresholds, signal, questions and mode from the settings, and records what it used each time", async () => {
    const a = await saveEnriched("a");
    const b = await saveEnriched("b");
    const signals = { a: { noul: 0.75, score: 1.8 }, b: { noul: 0.65, score: 2.6 } };
    fixture.respond(answerBy(signals), answerBy(signals), answerBy(signals));

    const first = await search();
    // A change between two searches, as a Flagship flag would make.
    const changed: SearchSettings = {
      questions: "noul",
      displaySignal: "noul",
      noulThreshold: 0.7,
      scoreThreshold: 2,
      requestMode: "batched",
    };
    const second = await search({ settings: changed });
    // The questions leave out the display signal, so the asked one ranks.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const third = await search({
      settings: { ...changed, questions: "score", displaySignal: "noul", scoreThreshold: 2.5 },
    });

    expect(resultIds(first)).toEqual([b, a]);
    expect(resultIds(second)).toEqual([a]);
    expect(resultIds(third)).toEqual([b]);
    expect(Object.values(sent(1).questions).map(({ type }) => type)).toEqual(["noul", "noul"]);
    expect(Object.values(sent(2).questions).map(({ type }) => type)).toEqual(["score", "score"]);
    expect(
      (await runs()).map((run) => [
        run.questions,
        run.display_signal,
        run.noul_threshold,
        run.score_threshold,
        run.request_mode,
      ]),
    ).toEqual([
      ["both", "score", 0.5, 1.5, "batched"],
      ["noul", "noul", 0.7, 2, "batched"],
      ["score", "score", 0.7, 2.5, "batched"],
    ]);
    // The signal that wasn't asked is empty in every answer.
    expect((await answerRows(second.runId)).map(({ noul, score }) => [noul, score])).toEqual([
      [0.75, null],
      [0.65, null],
    ]);
  });

  describe("in pair mode", () => {
    const pairSettings = { ...SEARCH_SETTING_DEFAULTS, requestMode: "pair" } as const;

    it("sends one request for each candidate, logs the run as pair, and returns the same results as batched mode", async () => {
      const best = await saveEnriched("best");
      const middle = await saveEnriched("middle");
      const worst = await saveEnriched("worst");
      const signals = {
        best: { noul: 0.9, score: 2.9 },
        middle: { noul: 0.7, score: 2.5 },
      };
      respondEach(answerBy(signals), 3);
      const pair = await search({ settings: pairSettings });

      // One request each, with one bookmark in the state, and the query as it is sent in batched mode.
      expect(fixture.requests).toHaveLength(3);
      for (const index of [0, 1, 2]) {
        expect(Object.keys(sent(index).state.bookmarks)).toHaveLength(1);
        expect(sent(index).state.query).toBe(QUERY);
      }
      expect(sentMatchTexts()).toEqual(["best", "middle", "worst"]);
      expect(resultIds(pair)).toEqual([best, middle]);
      expect(await runs()).toEqual([
        expect.objectContaining({
          id: pair.runId,
          request_mode: "pair",
          outcome: "ok",
          error: null,
          jev_model: ANSWERING_MODEL,
          input_tokens: 300,
        }),
      ]);
      // Every candidate is logged, the one below both thresholds too.
      expect(new Set((await answerRows(pair.runId)).map(({ bookmark_id }) => bookmark_id))).toEqual(
        new Set([best, middle, worst]),
      );

      // Batched mode, given the same answers, returns the same results.
      fixture.reset();
      fixture.respond(answerBy(signals));
      const batched = await search();
      expect(batched.results).toEqual(pair.results);
      expect(batched.outcome).toBe(pair.outcome);
    });

    it("returns the answered results of a partial failure, and the failed outcome when every request fails", async () => {
      const answered = await saveEnriched("answered");
      await saveEnriched("refused");
      const answer = answerBy({ answered: { noul: 0.9, score: 2.9 } });
      respondEach(async (request) => {
        const body = (await request.clone().json()) as SentBody;
        const asked = Object.values(body.state.bookmarks).map(({ match_text }) => match_text);
        return asked.includes("refused")
          ? HttpResponse.json({ detail: "fixture error" }, { status: 400 })
          : answer(request);
      }, 2);
      const partial = await search({ settings: pairSettings });
      expect(partial).toEqual({
        runId: expect.any(String),
        outcome: "partial",
        results: [expect.objectContaining({ id: answered })],
      });
      expect(await runs()).toEqual([
        expect.objectContaining({
          request_mode: "pair",
          outcome: "partial",
          error: "status:400",
          input_tokens: 100,
        }),
      ]);
      expect((await answerRows(partial.runId)).map(({ bookmark_id }) => bookmark_id)).toEqual([
        answered,
      ]);

      fixture.reset();
      respondEach(status(400), 2);
      const failed = await search({ settings: pairSettings });
      expect(failed).toEqual({ runId: expect.any(String), outcome: "failed", results: [] });
      expect((await runs()).at(-1)).toMatchObject({
        request_mode: "pair",
        outcome: "failed",
        error: "status:400",
        jev_model: CONFIGURED_MODEL,
        input_tokens: 0,
      });
    });

    it("ends at the same deadline, keeping what Jev answered and logging the rest as unanswered", async () => {
      await saveEnriched("first");
      await saveEnriched("second");
      await saveEnriched("third");
      const clock = fakeClock();
      // A request's tokens count for far longer than the deadline at 1 token a second, so the
      // second and third requests wait past it.
      const limiter = new JevLimiter({ requestsPerSecond: 10, tokensPerSecond: 1 }, clock);
      let answered = 0;
      const answer = answerBy();
      fixture.respond(async (request) => {
        const response = await answer(request);
        answered += 1;
        return response;
      });
      let settled = false;
      const searching = search({ settings: pairSettings, limiter, clock }).finally(() => {
        settled = true;
      });
      await vi.waitFor(() => {
        expect(answered).toBe(1);
      });
      await clock.advance(SEARCH_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      await clock.advance(1);
      const result = await searching;
      expect(result.outcome).toBe("partial");
      expect(fixture.requests).toHaveLength(1);
      expect(await runs()).toEqual([
        expect.objectContaining({
          request_mode: "pair",
          outcome: "partial",
          error: "aborted",
          latency_ms: SEARCH_DEADLINE_MS,
          input_tokens: 100,
        }),
      ]);
      expect(await answerRows(result.runId)).toHaveLength(1);
    });
  });

  it("asks only about bookmarks that have at least one enrichment", async () => {
    const DB = await d1();
    const url = "https://example.com/pending";
    await seedBookmark(DB, owner.userId, url, url);
    await saveEnriched("enriched");
    fixture.respond(answerBy());
    const { runId } = await search();
    expect(sentMatchTexts()).toEqual(["enriched"]);
    expect(await answerRows(runId)).toHaveLength(1);
  });

  it("never asks about a Held bookmark, and drops a Current one that a lowered threshold holds", async () => {
    await saveEnriched("held", { sensitivityNoul: 0.9 });
    await saveEnriched("released", { sensitivityNoul: 0.9, sensitivityAcknowledgedAt: 1_000 });
    const borderline = await saveEnriched("borderline", { sensitivityNoul: 0.6 });
    const matched = { noul: 0.9, score: 2.9 };
    const signals = { held: matched, released: matched, borderline: matched };
    fixture.respond(answerBy(signals));

    const before = await search({ policy: { ...policy, sensitiveWarnThreshold: 0.7 } });
    expect(sentMatchTexts()).toEqual(["borderline", "released"]);
    expect(resultIds(before)).toContain(borderline);

    fixture.reset();
    fixture.respond(answerBy(signals));
    const after = await search({ policy: { ...policy, sensitiveWarnThreshold: 0.5 } });
    expect(sentMatchTexts()).toEqual(["released"]);
    expect(resultIds(after)).not.toContain(borderline);
    expect((await answerRows(after.runId)).map(({ bookmark_id }) => bookmark_id)).not.toContain(
      borderline,
    );
  });

  it("asks about each bookmark's most recent enrichment, one at an older schema version too", async () => {
    const DB = await d1();
    await saveEnriched("older only", { schemaVersion: OLDER_VERSION });
    const url = "https://example.com/both";
    const both = await seedBookmark(DB, owner.userId, url, url);
    await seedEnrichment(DB, both, OLDER_VERSION, { matchText: "replaced", createdAt: 1_000 });
    await seedEnrichment(DB, both, ENRICHMENT_SCHEMA_VERSION, {
      matchText: "current",
      createdAt: 2_000,
    });
    fixture.respond(answerBy());
    await search();
    expect(sentMatchTexts()).toEqual(["current", "older only"]);
  });

  it("asks about the enrichment written last, even when it is at the older schema version", async () => {
    const DB = await d1();
    // After a Worker rollback, the older version can be written after the current one.
    const rolledBack = await seedBookmark(DB, owner.userId, "https://example.com/r", "r");
    await seedEnrichment(DB, rolledBack, ENRICHMENT_SCHEMA_VERSION, {
      matchText: "written before the rollback",
      createdAt: 1_000,
    });
    await seedEnrichment(DB, rolledBack, OLDER_VERSION, {
      matchText: "written after the rollback",
      createdAt: 2_000,
    });
    // Two enrichments written in the same millisecond: the higher schema version is used.
    const together = await seedBookmark(DB, owner.userId, "https://example.com/t", "t");
    await seedEnrichment(DB, together, ENRICHMENT_SCHEMA_VERSION, {
      matchText: "same time, current version",
      createdAt: 3_000,
    });
    await seedEnrichment(DB, together, OLDER_VERSION, {
      matchText: "same time, older version",
      createdAt: 3_000,
    });
    fixture.respond(answerBy());
    await search();
    expect(sentMatchTexts()).toEqual(["same time, current version", "written after the rollback"]);
  });

  it("returns an empty result for an empty collection, asks Jev nothing, and logs the run", async () => {
    const DB = await d1();
    const url = "https://example.com/pending";
    await seedBookmark(DB, owner.userId, url, url);
    const result = await search();
    expect(result).toEqual({ runId: expect.any(String), outcome: "ok", results: [] });
    expect(fixture.requests).toEqual([]);
    expect(await runs()).toEqual([
      expect.objectContaining({
        id: result.runId,
        outcome: "ok",
        error: null,
        jev_model: CONFIGURED_MODEL,
        input_tokens: 0,
      }),
    ]);
    expect(await answerRows()).toEqual([]);
  });

  it.each([
    ["that is over the cap", "x".repeat(SEARCH_QUERY_CAP + 1)],
    ["that is only spaces", "   "],
    // Under the cap once trimmed, but stored as given, so the stored text would be over it.
    ["that is over the cap only with its spaces", `x${" ".repeat(SEARCH_QUERY_CAP)}`],
  ])("rejects a query %s, and sends and logs nothing", async (_, query) => {
    await saveEnriched("only");
    const rejected = search({}, query);
    await expect(rejected).rejects.toMatchObject({
      name: "SearchRejectedError",
      code: "SEARCH_QUERY_INVALID",
    });
    await expect(rejected).rejects.not.toHaveProperty("message", expect.stringContaining("xxx"));
    expect(fixture.requests).toEqual([]);
    expect(await runs()).toEqual([]);
  });

  it.each([
    ["without spaces", "x".repeat(SEARCH_QUERY_CAP)],
    ["with spaces around it", ` ${"x".repeat(SEARCH_QUERY_CAP - 2)} `],
  ])("accepts a query at the cap, %s, and stores it as given", async (_, query) => {
    await saveEnriched("only");
    fixture.respond(answerBy());
    await expect(search({}, query)).resolves.toMatchObject({ outcome: "ok" });
    expect((await runs()).map((run) => run.query)).toEqual([query]);
  });

  it("leaves out a deleted bookmark, whose delete removes its answers and keeps the runs", async () => {
    const kept = await saveEnriched("kept");
    const deleted = await saveEnriched("deleted");
    const matched = { noul: 0.9, score: 2.9 };
    fixture.respond(answerBy({ kept: matched, deleted: matched }));
    const before = await search();
    expect(resultIds(before).toSorted()).toEqual([kept, deleted].toSorted());

    const response = await server.fetch(`/bookmarks/${deleted}/delete`, {
      method: "POST",
      headers: { origin, cookie: owner.cookie },
      body: new URLSearchParams({ confirm: "yes" }),
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<p>Deleted “Title deleted”.</p>");

    fixture.reset();
    fixture.respond(answerBy({ kept: matched, deleted: matched }));
    const after = await search();
    expect(resultIds(after)).toEqual([kept]);
    expect(sentMatchTexts()).toEqual(["kept"]);
    expect((await runs()).map(({ id }) => id)).toEqual([before.runId, after.runId]);
    expect((await answerRows(before.runId)).map(({ bookmark_id }) => bookmark_id)).toEqual([kept]);
  });

  it("neither logs nor returns a bookmark deleted while Jev was answering, and keeps the search", async () => {
    const kept = await saveEnriched("kept");
    const deleted = await saveEnriched("deleted");
    const matched = { noul: 0.9, score: 2.9 };
    const answer = answerBy({ kept: matched, deleted: matched });
    fixture.respond(async (request) => {
      const DB = await d1();
      await DB.prepare("DELETE FROM bookmarks WHERE id = ?").bind(deleted).run();
      return answer(request);
    });
    const result = await search();
    expect(result.outcome).toBe("ok");
    expect((await answerRows(result.runId)).map(({ bookmark_id }) => bookmark_id)).toEqual([kept]);
    // The link is gone, so it isn't returned either.
    expect(resultIds(result)).toEqual([kept]);
  });

  it("never reads or returns another user's bookmarks, and logs each search as its user's", async () => {
    const DB = await d1();
    const second = await seedSignedInUser(DB, "second@example.com");
    const mine = await saveEnriched("mine");
    const theirs = await saveEnriched("theirs", { userId: second.userId });
    const matched = { noul: 0.9, score: 2.9 };
    fixture.respond(answerBy({ mine: matched, theirs: matched }));
    const ownerResult = await search();
    expect(sentMatchTexts()).toEqual(["mine"]);

    fixture.reset();
    fixture.respond(answerBy({ mine: matched, theirs: matched }));
    const secondResult = await search({}, QUERY, WEB, second.userId);
    expect(sentMatchTexts()).toEqual(["theirs"]);

    expect(resultIds(ownerResult)).toEqual([mine]);
    expect(resultIds(secondResult)).toEqual([theirs]);
    expect((await runs()).map(({ id, user_id }) => [id, user_id])).toEqual([
      [ownerResult.runId, owner.userId],
      [secondResult.runId, second.userId],
    ]);
    expect((await answerRows(ownerResult.runId)).map(({ bookmark_id }) => bookmark_id)).toEqual([
      mine,
    ]);
    expect((await answerRows(secondResult.runId)).map(({ bookmark_id }) => bookmark_id)).toEqual([
      theirs,
    ]);
  });

  it("returns the answered results of a partial failure, logs it as partial, and logs only what Jev answered", async () => {
    const answered = await saveEnriched("answered");
    await saveEnriched("refused");
    // The whole chunk is too long, so it is split, and the half about `refused` gets a 400.
    const halves = answerBy({ answered: { noul: 0.9, score: 2.9 } });
    const refuseHalf: JevResolver = async (request) => {
      const body = (await request.clone().json()) as SentBody;
      const asked = Object.values(body.state.bookmarks).map(({ match_text }) => match_text);
      return asked.includes("refused")
        ? HttpResponse.json({ detail: "fixture error" }, { status: 400 })
        : halves(request);
    };
    fixture.respond(
      () =>
        HttpResponse.json(
          { detail: "max_tokens_exceeded: the request is longer than the model's context length" },
          { status: 400 },
        ),
      refuseHalf,
      refuseHalf,
    );
    const result = await search();
    expect(result).toEqual({
      runId: expect.any(String),
      outcome: "partial",
      results: [expect.objectContaining({ id: answered })],
    });
    expect(await runs()).toEqual([
      expect.objectContaining({
        outcome: "partial",
        error: "status:400",
        jev_model: ANSWERING_MODEL,
        input_tokens: 100,
      }),
    ]);
    expect((await answerRows(result.runId)).map(({ bookmark_id }) => bookmark_id)).toEqual([
      answered,
    ]);
  });

  it("returns the failed outcome when every request fails, not an empty list, and logs the configured model", async () => {
    await saveEnriched("only");
    fixture.respond(status(503), status(503), status(503));
    const result = await search();
    expect(result).toEqual({ runId: expect.any(String), outcome: "failed", results: [] });
    expect(await runs()).toEqual([
      expect.objectContaining({
        id: result.runId,
        outcome: "failed",
        error: "status:503",
        jev_model: CONFIGURED_MODEL,
        input_tokens: 0,
      }),
    ]);
    expect(await answerRows()).toEqual([]);
  });

  it("keeps the query, the response body and the key out of `error` and every log line", async () => {
    const lines: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      });
    }
    await saveEnriched("only");
    // A failed search, one whose 400's body the client reads, a successful one, a pair-mode one
    // whose 400's body the client reads, then a rejected one.
    fixture.respond(
      status(500),
      status(500),
      status(500),
      () => HttpResponse.json({ detail: `${BODY_MARKER} bad request` }, { status: 400 }),
      answerBy(),
      () => HttpResponse.json({ detail: `${BODY_MARKER} bad request` }, { status: 400 }),
    );
    await search();
    await search();
    await search();
    await search({ settings: { ...SEARCH_SETTING_DEFAULTS, requestMode: "pair" } });
    await expect(search({}, `${QUERY} ${"x".repeat(SEARCH_QUERY_CAP)}`)).rejects.toMatchObject({
      code: "SEARCH_QUERY_INVALID",
    });

    // The service logs each search it ran, so the check below has lines to look at.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const logged = JSON.stringify(lines);
    const errors = JSON.stringify((await runs()).map(({ error }) => error));
    expect(errors).toBe(JSON.stringify(["status:500", "status:400", null, "status:400"]));
    for (const secret of [QUERY, "fixture error", BODY_MARKER, KEY]) {
      expect(logged).not.toContain(secret);
      expect(errors).not.toContain(secret);
    }
  });

  // The page gives up after its TIMEOUT_MS. An attempt under way at the deadline still runs to its
  // own time limit, and the run is then logged and answered, so the three must fit inside it.
  it("ends the search at a deadline that leaves an attempt and the response inside the page's limit", async () => {
    const script = await readFile(
      new URL("../../web/public/assets/search.js", import.meta.url),
      "utf8",
    );
    const pageLimit = Number(
      /const TIMEOUT_MS = ([\d_]+);/u.exec(script)?.[1]?.replaceAll("_", ""),
    );
    expect(pageLimit).toBe(30_000);
    expect(SEARCH_RESPONSE_MARGIN_MS).toBeGreaterThan(0);
    expect(SEARCH_DEADLINE_MS + SEARCH_TIMING.attemptTimeoutMs + SEARCH_RESPONSE_MARGIN_MS).toBe(
      pageLimit,
    );
  });

  it("keeps what Jev answered by the deadline, and logs the rest as unanswered and the run as partial", async () => {
    const ids = await seedSeveralChunks();
    const clock = fakeClock();
    // A full chunk's tokens count for many seconds at 1,000 tokens a second, so the second chunk
    // waits past the deadline.
    const limiter = new JevLimiter({ requestsPerSecond: 10, tokensPerSecond: 1000 }, clock);
    let answered = 0;
    const answer = answerBy();
    fixture.respond(async (request) => {
      const response = await answer(request);
      answered += 1;
      return response;
    });
    let settled = false;
    const searching = search({ limiter, clock }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(answered).toBe(1);
    });
    await clock.advance(SEARCH_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await clock.advance(1);
    const result = await searching;

    expect(result.outcome).toBe("partial");
    expect(fixture.requests).toHaveLength(1);
    const firstChunk = Object.keys(sent().state.bookmarks).length;
    expect(firstChunk).toBeLessThan(ids.length);
    expect(await runs()).toEqual([
      expect.objectContaining({
        outcome: "partial",
        error: "aborted",
        latency_ms: SEARCH_DEADLINE_MS,
        input_tokens: 100 * firstChunk,
      }),
    ]);
    expect(await answerRows(result.runId)).toHaveLength(firstChunk);
  });

  it("ends at the deadline the caller passes, as an evaluation run may", async () => {
    await seedSeveralChunks();
    const clock = fakeClock();
    const limiter = new JevLimiter({ requestsPerSecond: 10, tokensPerSecond: 1000 }, clock);
    let answered = 0;
    const answer = answerBy();
    fixture.respond(async (request) => {
      const response = await answer(request);
      answered += 1;
      return response;
    });
    const deadlineMs = 5_000;
    let settled = false;
    const searching = search({ limiter, clock, deadlineMs }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(answered).toBe(1);
    });
    await clock.advance(deadlineMs - 1);
    expect(settled).toBe(false);
    await clock.advance(1);
    await vi.waitFor(() => {
      expect(settled).toBe(true);
    });
    const result = await searching;
    expect(result.outcome).toBe("partial");
    expect(await runs()).toEqual([
      expect.objectContaining({ outcome: "partial", error: "aborted", latency_ms: deadlineMs }),
    ]);
  });

  // The deadline covers the whole search, so a deadline that passes while the candidates are
  // read ends the search before anything is sent.
  it("starts the deadline before it reads the candidates", async () => {
    await saveEnriched("only");
    // Answers the request that a deadline started after the read would let through.
    fixture.respond(answerBy());
    const result = await search({ deadlineMs: 0, clock: undefined });
    expect(result).toEqual({ runId: expect.any(String), outcome: "failed", results: [] });
    expect(fixture.requests).toEqual([]);
    expect(await runs()).toEqual([
      expect.objectContaining({ outcome: "failed", error: "aborted" }),
    ]);
  });
});

describe("writeSearchLog", () => {
  it("logs no answer for a bookmark that isn't the run's user's", async () => {
    const DB = await d1();
    const second = await seedSignedInUser(DB, "second@example.com");
    const mine = await saveEnriched("mine");
    const theirs = await saveEnriched("theirs", { userId: second.userId });
    const { runId, loggedBookmarkIds } = await writeSearchLog(db, runLog(), [
      { bookmarkId: mine, noul: 0.9, score: null, shown: true },
      { bookmarkId: theirs, noul: 0.9, score: null, shown: true },
    ]);
    expect((await answerRows(runId)).map(({ bookmark_id }) => bookmark_id)).toEqual([mine]);
    expect([...loggedBookmarkIds]).toEqual([mine]);
  });

  // D1 bills every row a statement reads (Q12). Checking each answer's bookmark must cost a few
  // rows for that answer, not a read of the whole collection for every statement, which would
  // grow with the square of the collection.
  it("reads a few rows for each answer it logs, however large the collection", async () => {
    const DB = await d1();
    const size = 200;
    const ids = await seedBookmarks(
      DB,
      owner.userId,
      Array.from({ length: size }, (_, index) => {
        const url = `https://example.com/${index}`;
        return { url, normalizedUrl: url, createdAt: index };
      }),
    );
    // The D1 binding, with each batch's results kept, so their `meta.rows_read` can be read.
    const metas: { rows_read: number }[][] = [];
    const counted = new Proxy(DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: unknown[]) => {
            const results = await target.batch(statements);
            metas.push(results.map(({ meta }: { meta: { rows_read: number } }) => meta));
            return results;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { loggedBookmarkIds } = await writeSearchLog(
      createDb(counted),
      runLog(),
      ids.map((bookmarkId) => ({ bookmarkId, noul: 0.5, score: null, shown: false })),
    );
    expect(loggedBookmarkIds.size).toBe(size);
    expect(metas).toHaveLength(1);
    // The first statement is the run's insert.
    const answerReads = metas[0]!.slice(1).reduce((sum, { rows_read }) => sum + rows_read, 0);
    expect(answerReads).toBeLessThanOrEqual(4 * size);
  });
});

// A run of the owner's, for the tests that call writeSearchLog directly.
function runLog(): Parameters<typeof writeSearchLog>[1] {
  return {
    userId: owner.userId,
    query: QUERY,
    channel: "eval",
    inputMode: null,
    requestMode: "batched",
    jevModel: ANSWERING_MODEL,
    questions: "noul",
    displaySignal: "noul",
    noulThreshold: 0.5,
    scoreThreshold: 1.5,
    inputTokens: 200,
    latencyMs: 10,
    outcome: "ok",
    error: null,
  };
}
