// POST /api/search (#214): the search page's route, a thin caller of the search service (#212).
// Two parts. The first calls the route's function in this process with a fake service, to show
// what it passes on, what it answers and what it leaves alone, and then with the real service and
// the Jev fixture, because only a call in this process can read the console. The second sends
// requests to the Worker, as the page does, to show the route's session and Origin checks, and
// that a real search from a signed-in user returns ranked results and logs both signals for every
// candidate. Every request to Jev is answered by the Jev fixture, which fails a test that makes
// a request it did not plan for, so no test calls TypeSafe. See "Search page" and "The search
// service" in plans/haystack-v1-implementation-plan.md.
import { SEARCH_QUERY_CAP, SearchAnswer } from "@haystack/schemas";
import * as v from "valibot";
import { readFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  type MockInstance,
  vi,
} from "vite-plus/test";
import { createDb, type Db } from "../src/db/client.ts";
import { ENRICHMENT_SCHEMA_VERSION } from "../src/enrichment/enrichment-schema.ts";
import {
  type FlagDetails,
  type FlagReader,
  SEARCH_SCORE_THRESHOLD_FLAG,
  SEARCH_SETTING_DEFAULTS,
} from "../src/flags.ts";
import { type SearchRouteEnv, type SearchService, postSearch } from "../src/search-route.ts";
import { SearchRejectedError } from "../src/search/search-bookmarks.ts";
import { JEV_ORIGIN, type JevFixture, startJevFixture, status } from "./jev-fixture.ts";
import { answerBy, type SentBody } from "./search-match-text-answers.ts";
import {
  seedBookmark,
  seedBookmarks,
  seedEnrichment,
  seedEnrichments,
  seedSignedInUser,
} from "./seed.ts";
import type { SeededUser } from "./seed.ts";
import { createTestWorker, withoutJsoncComments } from "./test-worker.ts";

const KEY = "ts-search-api-key-7d1f";

const server = createTestWorker({
  vars: { ALLOWED_EMAILS: "owner@example.com, second@example.com" },
  secrets: { TYPESAFE_API_KEY: KEY },
});

let fixture: JevFixture;
let origin: string;
let owner: SeededUser;
let db: Db;

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

// A query that no fixed text contains, so finding it anywhere means it leaked.
const QUERY = "quokka-telescope-marmalade 7c41";

interface Counts {
  readonly runs: number;
  readonly answers: number;
}

// The search tables' sizes, to show that a route left them alone.
async function tableCounts(): Promise<Counts> {
  const row = await (
    await d1()
  )
    .prepare(
      "SELECT (SELECT count(*) FROM search_runs) AS runs, (SELECT count(*) FROM search_answers) AS answers",
    )
    .first();
  return { runs: Number(row.runs), answers: Number(row.answers) };
}

/** A fake binding with these flags set, and every other flag missing. */
function flagsWith(values: Record<string, unknown>): FlagReader {
  const read = async <T>(key: string, defaultValue: T): Promise<FlagDetails<T>> =>
    Object.hasOwn(values, key)
      ? { value: values[key] as T }
      : { value: defaultValue, errorCode: "FLAG_NOT_FOUND" };
  return { getBooleanDetails: read, getNumberDetails: read, getStringDetails: read };
}

const env: SearchRouteEnv = {
  JEV_BASE_URL: JEV_ORIGIN,
  JEV_MODEL: "jev-1.14.0",
  TYPESAFE_API_KEY: KEY,
  SENSITIVE_WARN_THRESHOLD: "0.5",
  SWEEP_ATTEMPT_LIMIT: "3",
  FLAGS: flagsWith({}),
};

function searchRequest(body: unknown, { signal }: { readonly signal?: AbortSignal } = {}): Request {
  return new Request("https://haystack.test/api/search", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

// What the fake service answers unless a test says otherwise.
const OK = { runId: "run-1", outcome: "ok", results: [] } as const;

/** A stand-in for the request's `ExecutionContext`, which keeps what is given to `waitUntil`. */
function fakeContext() {
  const registered: Promise<unknown>[] = [];
  return {
    registered,
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      registered.push(promise);
    }),
  };
}

function fakeService(answer: Awaited<ReturnType<SearchService>> = OK): Mock<SearchService> {
  return vi.fn<SearchService>(async () => answer);
}

describe("postSearch, with a fake service", () => {
  it("gives the service the session's user, the query trimmed, the web channel and what it reads", async () => {
    const service = fakeService();
    const flags = flagsWith({ [SEARCH_SCORE_THRESHOLD_FLAG]: 2.2 });
    await postSearch(
      searchRequest({ query: `  ${QUERY} `, userId: "someone-else", channel: "eval" }),
      fakeContext(),
      db,
      owner.userId,
      { ...env, FLAGS: flags },
      service,
    );

    expect(service).toHaveBeenCalledTimes(1);
    const [userId, query, source, context] = service.mock.calls[0] ?? [];
    expect(userId).toBe(owner.userId);
    expect(query).toBe(QUERY);
    expect(source).toEqual({ channel: "web", inputMode: "typed" });
    expect(context).toEqual({
      db,
      jev: expect.objectContaining({
        JEV_BASE_URL: JEV_ORIGIN,
        JEV_MODEL: "jev-1.14.0",
        TYPESAFE_API_KEY: KEY,
      }),
      settings: { ...SEARCH_SETTING_DEFAULTS, scoreThreshold: 2.2 },
      policy: {
        schemaVersion: ENRICHMENT_SCHEMA_VERSION,
        sensitiveWarnThreshold: 0.5,
        attemptLimit: 3,
      },
      signal: expect.any(AbortSignal),
    });
    // The web route keeps the service's deadline, limiter and timing.
    expect(context).not.toHaveProperty("deadlineMs");
    expect(context).not.toHaveProperty("limiter");
  });

  // The page says how the query was entered (#217), and the route passes that on for the web.
  it("gives the service the input mode the body names, for the web", async () => {
    const service = fakeService();
    await postSearch(
      searchRequest({ query: QUERY, inputMode: "web-speech" }),
      fakeContext(),
      db,
      owner.userId,
      env,
      service,
    );
    expect(service.mock.calls[0]?.[2]).toEqual({ channel: "web", inputMode: "web-speech" });
  });

  // The endpoint adds nothing: the service's result, in the service's order, and no row of its
  // own in the search tables.
  it("answers with the service's result in the service's order, and leaves the search tables alone", async () => {
    const result = {
      runId: "run-7",
      outcome: "ok",
      results: [
        {
          id: "b-3",
          title: "Third saved",
          description: null,
          url: "https://example.com/3",
          createdAt: 3_000,
        },
        {
          id: "b-1",
          title: "First saved",
          description: "Notes",
          url: "https://example.com/1",
          createdAt: 1_000,
        },
        {
          id: "b-2",
          title: "Second saved",
          description: null,
          url: "https://example.com/2",
          createdAt: 2_000,
        },
      ],
    } as const;
    const before = await tableCounts();

    const response = await postSearch(
      searchRequest({ query: QUERY }),
      fakeContext(),
      db,
      owner.userId,
      env,
      fakeService(result),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body: unknown = await response.json();
    expect(body).toEqual(result);
    expect(v.safeParse(SearchAnswer, body).success).toBe(true);
    expect(await tableCounts()).toEqual(before);
  });

  it("answers a partial search with 200 and its results, so the page can say they may be incomplete", async () => {
    const partial = {
      runId: "run-8",
      outcome: "partial",
      results: [
        {
          id: "b-1",
          title: "Found",
          description: null,
          url: "https://example.com/1",
          createdAt: 1_000,
        },
      ],
    } as const;
    const response = await postSearch(
      searchRequest({ query: QUERY }),
      fakeContext(),
      db,
      owner.userId,
      env,
      fakeService(partial),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(partial);
  });

  // The one thing the route does with a result: a search that got no answer from Jev is an error,
  // never an empty list. 502, not 503, because the Worker is a gateway to Jev and got no usable
  // answer from it, which also tells the metrics of a Jev outage from a 500 of Haystack's own.
  // No Retry-After: the page doesn't read it, and nothing says when Jev is back.
  it("answers a failed search with 502 and no Retry-After, and no results", async () => {
    const failed = { runId: "run-9", outcome: "failed", results: [] } as const;
    const response = await postSearch(
      searchRequest({ query: QUERY }),
      fakeContext(),
      db,
      owner.userId,
      env,
      fakeService(failed),
    );
    expect(response.status).toBe(502);
    expect(response.headers.has("retry-after")).toBe(false);
    expect(await response.json()).toEqual({ code: "SEARCH_UNAVAILABLE" });
  });

  it("passes the request's signal on, so a search the page abandoned stops", async () => {
    const abandoned = new AbortController();
    let given: AbortSignal | undefined;
    const service = vi.fn<SearchService>(async (_user, _query, _source, { signal }) => {
      given = signal;
      expect(signal?.aborted).toBe(false);
      abandoned.abort();
      // The signal reaches the service as it aborts, not at the next request.
      expect(signal?.aborted).toBe(true);
      return OK;
    });
    await postSearch(
      searchRequest({ query: QUERY }, { signal: abandoned.signal }),
      fakeContext(),
      db,
      owner.userId,
      env,
      service,
    );
    expect(given).toBeDefined();
  });

  // The page has gone, so the answer is for nobody. It isn't a failure of Jev's either, which a
  // 502 or a 5xx would count as: the page aborts the search it replaces whenever the query
  // changes.
  it.each(["ok", "partial", "failed"] as const)(
    "answers a search the page abandoned with 499, whatever its outcome (%s)",
    async (outcome) => {
      const abandoned = new AbortController();
      const service = vi.fn<SearchService>(async () => {
        abandoned.abort();
        return { runId: "run-10", outcome, results: [] };
      });
      const response = await postSearch(
        searchRequest({ query: QUERY }, { signal: abandoned.signal }),
        fakeContext(),
        db,
        owner.userId,
        env,
        service,
      );
      expect(response.status).toBe(499);
      expect(await response.text()).toBe("");
    },
  );

  it.each([
    ["JSON that doesn't parse", "{ nope", "SEARCH_REQUEST_INVALID"],
    ["a body that is not an object", "[]", "SEARCH_QUERY_INVALID"],
    ["null", "null", "SEARCH_QUERY_INVALID"],
    ["no query", "{}", "SEARCH_QUERY_INVALID"],
    ["a query that is not a string", '{"query":42}', "SEARCH_QUERY_INVALID"],
    ["an empty query", '{"query":""}', "SEARCH_QUERY_INVALID"],
    ["a query of spaces", '{"query":"   "}', "SEARCH_QUERY_INVALID"],
    [
      "a query over the cap",
      JSON.stringify({ query: "a".repeat(SEARCH_QUERY_CAP + 1) }),
      "SEARCH_QUERY_INVALID",
    ],
    // `whisper` is reserved for the backlog, and the page can't send it, so it is refused as any
    // unknown mode is. The query is fine here, so the code names the request, not the query.
    ["the input mode whisper", '{"query":"a","inputMode":"whisper"}', "SEARCH_REQUEST_INVALID"],
    ["an unknown input mode", '{"query":"a","inputMode":"keyboard"}', "SEARCH_REQUEST_INVALID"],
  ])("answers %s with 400, and never calls the service", async (_, body, code) => {
    const service = fakeService();
    const response = await postSearch(
      searchRequest(body),
      fakeContext(),
      db,
      owner.userId,
      env,
      service,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code });
    expect(service).not.toHaveBeenCalled();
  });

  // This uses the real service, so a run that the refusal failed to stop would show in the tables.
  it.each(['{"query":"a","inputMode":"whisper"}', '{"query":"a","inputMode":"keyboard"}'])(
    "stores no search run for the body %s",
    async (body) => {
      const before = await tableCounts();
      const response = await postSearch(searchRequest(body), fakeContext(), db, owner.userId, env);
      expect(response.status).toBe(400);
      expect(await tableCounts()).toEqual(before);
    },
  );

  it("answers a body past its cap with 413, without calling the service", async () => {
    const service = fakeService();
    const response = await postSearch(
      searchRequest({ query: "a", padding: "x".repeat(64 * 1024) }),
      fakeContext(),
      db,
      owner.userId,
      env,
      service,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: "SEARCH_REQUEST_TOO_LARGE" });
    expect(service).not.toHaveBeenCalled();
  });

  // The cap is a body "past" 8 KiB, so a body of exactly 8 KiB is read whole, and one byte more is not.
  it.each([
    ["exactly the cap, with 200", 8 * 1024, 200],
    ["one byte over the cap, with 413", 8 * 1024 + 1, 413],
  ])("answers a body of %s", async (_, size, status) => {
    const json = '{"query":"a"}';
    const service = fakeService();
    const response = await postSearch(
      searchRequest(json + " ".repeat(size - json.length)),
      fakeContext(),
      db,
      owner.userId,
      env,
      service,
    );
    expect(response.status).toBe(status);
  });

  // Every UTF-16 code unit escaped as `\uXXXX` is 6 bytes, the most a character of the query can
  // take in the body, so the body's cap has to hold a whole query written that way.
  it("accepts a query at the cap, even when every character is escaped in the body", async () => {
    const service = fakeService();
    const response = await postSearch(
      searchRequest(`{"query":"${"\\ud83d\\ude00".repeat(SEARCH_QUERY_CAP / 2)}"}`),
      fakeContext(),
      db,
      owner.userId,
      env,
      service,
    );
    expect(response.status).toBe(200);
    expect(service.mock.calls[0]?.[1]).toBe("\u{1f600}".repeat(SEARCH_QUERY_CAP / 2));
  });

  // The route answers with the code the service gave, not a code of its own. The service has one
  // code today, so the test gives it one the type doesn't know, to show that it is passed on.
  it("answers a rejection by the service with 400 and its code", async () => {
    const service = vi.fn<SearchService>(async () => {
      throw new SearchRejectedError("SEARCH_OTHER_CODE" as never, "Refused for another reason");
    });
    const response = await postSearch(
      searchRequest({ query: QUERY }),
      fakeContext(),
      db,
      owner.userId,
      env,
      service,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "SEARCH_OTHER_CODE" });
  });

  // The runtime may cancel a request's handler when the client disconnects, so the search that
  // writes the log is also given to `waitUntil`, which keeps it running for up to 30 seconds.
  it("gives the search to waitUntil, so that it finishes whatever happens to the request", async () => {
    const context = fakeContext();
    let finished = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = vi.fn<SearchService>(async () => {
      await gate;
      finished = true;
      return OK;
    });
    const handling = postSearch(
      searchRequest({ query: QUERY }),
      context,
      db,
      owner.userId,
      env,
      service,
    );
    await vi.waitFor(() => expect(context.waitUntil).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    release();
    await context.registered[0];
    expect(finished).toBe(true);
    expect((await handling).status).toBe(200);
  });

  it("gives waitUntil a promise that never rejects, whatever the service throws", async () => {
    const context = fakeContext();
    const service = vi.fn<SearchService>(async () => {
      throw Object.assign(new Error("secret detail"), { code: "TYPESAFE_API_KEY_EMPTY" });
    });
    const handling = postSearch(
      searchRequest({ query: QUERY }),
      context,
      db,
      owner.userId,
      env,
      service,
    );
    // The handler's rejection is watched from the start, as the entry point watches it.
    const handled = expect(handling).rejects.toThrow("secret detail");
    await vi.waitFor(() => expect(context.waitUntil).toHaveBeenCalledTimes(1));
    await expect(context.registered[0]).resolves.toBeUndefined();
    await handled;
  });

  // When the client has gone, the handler may be cancelled before it rethrows to the entry point,
  // which is the only code that logs, so the background branch logs the failure, by its code only.
  it("logs the code of a failure when the client left, and answers 499 instead of throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const page = new AbortController();
    const context = fakeContext();
    const service = vi.fn<SearchService>(async () => {
      await Promise.resolve();
      page.abort();
      throw Object.assign(new Error("secret detail"), { code: "TYPESAFE_API_KEY_EMPTY" });
    });
    const handling = postSearch(
      searchRequest({ query: QUERY }, { signal: page.signal }),
      context,
      db,
      owner.userId,
      env,
      service,
    );
    // Only what waitUntil holds is awaited, as for a cancelled handler.
    await vi.waitFor(() => expect(context.waitUntil).toHaveBeenCalledTimes(1));
    await context.registered[0];
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).toContain("TYPESAFE_API_KEY_EMPTY");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret detail");
    expect((await handling).status).toBe(499);
    error.mockRestore();
  });

  // The entry point logs a failure that reaches it, so the background branch must not log it too.
  it("does not log a failure itself while the client is connected", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const context = fakeContext();
    const service = vi.fn<SearchService>(async () => {
      throw Object.assign(new Error("secret detail"), { code: "TYPESAFE_API_KEY_EMPTY" });
    });
    const handling = postSearch(
      searchRequest({ query: QUERY }),
      context,
      db,
      owner.userId,
      env,
      service,
    );
    const handled = expect(handling).rejects.toThrow("secret detail");
    await vi.waitFor(() => expect(context.waitUntil).toHaveBeenCalledTimes(1));
    await context.registered[0];
    await handled;
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  // A configuration error or a database error isn't the caller's mistake, so it is the entry
  // point's 500, which logs the error's code and never its message.
  it("lets any other error through, to the entry point's 500", async () => {
    const service = vi.fn<SearchService>(async () => {
      throw Object.assign(new Error("secret detail"), { code: "TYPESAFE_API_KEY_EMPTY" });
    });
    await expect(
      postSearch(searchRequest({ query: QUERY }), fakeContext(), db, owner.userId, env, service),
    ).rejects.toThrow("secret detail");
  });
});

// The service is the real one here, so the console holds what a search really writes.
describe("postSearch, with the search service", () => {
  let logs: MockInstance[];

  beforeEach(() => {
    logs = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
  });

  function logged(): string {
    return JSON.stringify(logs.flatMap((log) => log.mock.calls));
  }

  async function saveEnriched(matchText: string, userId = owner.userId): Promise<string> {
    const DB = await d1();
    const url = `https://example.com/${matchText}`;
    const id = await seedBookmark(DB, userId, url, url, { title: `Title ${matchText}` });
    await seedEnrichment(DB, id, ENRICHMENT_SCHEMA_VERSION, { matchText, kind: "tool" });
    return id;
  }

  it.each([
    [
      "finds something",
      async () => fixture.respond(answerBy({ found: { noul: 0.9, score: 2.8 } })),
      200,
    ],
    ["gets no answer from Jev", async () => fixture.respond(status(400)), 502],
  ])(
    "writes the query to no log, and not to the answer, when a search %s",
    async (_, respond, httpStatus) => {
      await saveEnriched("found");
      await respond();

      const response = await postSearch(
        searchRequest({ query: QUERY }),
        fakeContext(),
        db,
        owner.userId,
        env,
      );

      expect(response.status).toBe(httpStatus);
      expect(await response.text()).not.toContain(QUERY);
      expect(logs.flatMap((log) => log.mock.calls).length).toBeGreaterThan(0);
      expect(logged()).not.toContain(QUERY);
      expect(logged()).not.toContain(KEY);
    },
  );

  // When the page leaves, the runtime may cancel the handler, but not what `waitUntil` holds. The
  // test doesn't wait for the handler: it lets only what `waitUntil` holds finish, as a cancelled
  // request would, and the run must be logged by then (#212: every valid search is logged).
  it("logs the run of a search whose page left while Jev was answering", async () => {
    await saveEnriched("found");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = answerBy({ found: { noul: 0.9, score: 2.8 } });
    fixture.respond(async (request) => {
      await gate;
      return answer(request);
    });
    const page = new AbortController();
    const context = fakeContext();

    const handling = postSearch(
      searchRequest({ query: QUERY }, { signal: page.signal }),
      context,
      db,
      owner.userId,
      env,
    );
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
    page.abort();
    release();
    // Only what waitUntil holds is awaited, not `handling`.
    await Promise.all(context.registered);

    expect(await tableCounts()).toEqual({ runs: 1, answers: 1 });
    expect((await handling).status).toBe(499);
  });

  it("writes the query to no log, and not to the answer, when it is refused", async () => {
    const query = `${QUERY} ${"a".repeat(SEARCH_QUERY_CAP)}`;
    const response = await postSearch(
      searchRequest({ query }),
      fakeContext(),
      db,
      owner.userId,
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(QUERY);
    expect(logged()).not.toContain(QUERY);
    expect(fixture.requests).toEqual([]);
  });

  it("writes the query to the body of no malformed request's answer either", async () => {
    const response = await postSearch(
      searchRequest(`{"query":"${QUERY}"`),
      fakeContext(),
      db,
      owner.userId,
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(QUERY);
    expect(logged()).not.toContain(QUERY);
  });
});

// What the page sends: the query as JSON, asking for JSON, from this origin.
function post(headers: Record<string, string>, body: unknown = { query: QUERY }) {
  return server.fetch("/api/search", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

function postAsOwner(body?: unknown, extra: Record<string, string> = {}) {
  return post({ origin, cookie: owner.cookie, ...extra }, body);
}

interface AnswerRow {
  readonly bookmark_id: string;
  readonly noul: number | null;
  readonly score: number | null;
  readonly score_probabilities: string | null;
  readonly shown: number;
}

async function answerRows(runId: string): Promise<AnswerRow[]> {
  const { results } = await (
    await d1()
  )
    .prepare("SELECT * FROM search_answers WHERE search_run_id = ? ORDER BY rowid")
    .bind(runId)
    .all();
  return results as AnswerRow[];
}

// The answer of a search that returned results, checked against the web answer's schema.
async function answerOf(response: Response): Promise<SearchAnswer> {
  expect(response.status).toBe(200);
  return v.parse(SearchAnswer, await response.json());
}

async function saveEnrichedFor(
  userId: string,
  matchText: string,
  createdAt: number,
): Promise<string> {
  const DB = await d1();
  const url = `https://example.com/${matchText}`;
  const id = await seedBookmark(DB, userId, url, url, {
    title: `Title ${matchText}`,
    description: `About ${matchText}`,
    createdAt,
  });
  await seedEnrichment(DB, id, ENRICHMENT_SCHEMA_VERSION, { matchText, kind: "tool" });
  return id;
}

describe("POST /api/search", () => {
  it("returns the ranked results of a real search, and logs both signals for every candidate", async () => {
    const best = await saveEnrichedFor(owner.userId, "best", 1_000);
    const next = await saveEnrichedFor(owner.userId, "next", 2_000);
    const below = await saveEnrichedFor(owner.userId, "below", 3_000);
    fixture.respond(
      answerBy({ best: { noul: 0.95, score: 2.9 }, next: { noul: 0.7, score: 1.8 } }),
    );

    const response = await postAsOwner({ query: `  ${QUERY} ` });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const answer = v.parse(SearchAnswer, await response.json());
    expect(answer).toEqual({
      runId: expect.any(String),
      outcome: "ok",
      results: [
        {
          id: best,
          title: "Title best",
          description: "About best",
          url: "https://example.com/best",
          createdAt: 1_000,
        },
        {
          id: next,
          title: "Title next",
          description: "About next",
          url: "https://example.com/next",
          createdAt: 2_000,
        },
      ],
    });

    // One request to Jev, with the query trimmed, as the page sends it.
    expect(fixture.requests).toHaveLength(1);
    expect((JSON.parse(fixture.requests[0]?.body ?? "") as SentBody).state.query).toBe(QUERY);

    const { results: runs } = await (await d1()).prepare("SELECT * FROM search_runs").all();
    expect(runs).toEqual([
      expect.objectContaining({
        id: answer.runId,
        user_id: owner.userId,
        channel: "web",
        input_mode: "typed",
        request_mode: "batched",
        outcome: "ok",
        error: null,
      }),
    ]);
    // Every candidate is logged, the one below both thresholds too, with both signals, and
    // `shown` marks the two that the answer returned.
    const rows = await answerRows(answer.runId);
    expect(rows.map(({ bookmark_id }) => bookmark_id).toSorted()).toEqual(
      [best, next, below].toSorted(),
    );
    for (const row of rows) {
      expect(row.noul).toBeTypeOf("number");
      expect(row.score).toBeTypeOf("number");
      expect(JSON.parse(row.score_probabilities ?? "null")).toBeTypeOf("object");
    }
    expect(
      rows
        .filter(({ shown }) => shown === 1)
        .map(({ bookmark_id }) => bookmark_id)
        .toSorted(),
    ).toEqual([best, next].toSorted());
  });

  it("returns 200 with no results for a search that finds nothing, which the page shows as a message", async () => {
    await saveEnrichedFor(owner.userId, "unrelated", 1_000);
    fixture.respond(answerBy());
    const response = await postAsOwner();
    expect(await answerOf(response)).toEqual({
      runId: expect.any(String),
      outcome: "ok",
      results: [],
    });
  });

  it("returns 502 and logs a failed run when Jev answers none of it, never an empty list", async () => {
    await saveEnrichedFor(owner.userId, "found", 1_000);
    fixture.respond(status(400));

    const response = await postAsOwner();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "SEARCH_UNAVAILABLE" });
    const { results: runs } = await (await d1()).prepare("SELECT * FROM search_runs").all();
    expect(runs).toEqual([
      expect.objectContaining({ outcome: "failed", error: "status:400", user_id: owner.userId }),
    ]);
  });

  it("returns the results of the chunks that were answered, as partial, when others fail", async () => {
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
    // Every bookmark's match is its own, so each answered chunk has results to show. The first
    // request is answered, and every other is refused for good, so no retry waits.
    const answer = answerBy(
      Object.fromEntries(
        ids.map((_, index) => [`${index} ${"x".repeat(2000)}`, { noul: 0.9, score: 2.9 }]),
      ),
    );
    fixture.respond(answer, ...Array.from({ length: 10 }, () => status(400)));

    const response = await postAsOwner();

    const body = await answerOf(response);
    expect(body.outcome).toBe("partial");
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThan(ids.length);
    const { results: runs } = await (await d1()).prepare("SELECT * FROM search_runs").all();
    expect(runs).toEqual([expect.objectContaining({ outcome: "partial", id: body.runId })]);
  });

  it("never reads, returns or logs another user's bookmarks", async () => {
    const DB = await d1();
    const second = await seedSignedInUser(DB, "second@example.com");
    const mine = await saveEnrichedFor(owner.userId, "mine", 1_000);
    const theirs = await saveEnrichedFor(second.userId, "theirs", 2_000);
    const matches = { mine: { noul: 0.9, score: 2.8 }, theirs: { noul: 0.9, score: 2.8 } };
    fixture.respond(answerBy(matches), answerBy(matches));

    const ownerAnswer = await answerOf(await postAsOwner());
    const secondAnswer = await answerOf(await post({ origin, cookie: second.cookie }));

    expect(ownerAnswer.results.map(({ id }) => id)).toEqual([mine]);
    expect(secondAnswer.results.map(({ id }) => id)).toEqual([theirs]);
    // Each request to Jev held only its user's bookmark.
    expect(fixture.requests.map(({ body }) => body.includes("theirs"))).toEqual([false, true]);
    expect(fixture.requests.map(({ body }) => body.includes("mine"))).toEqual([true, false]);
    // And each run, with its answers, is its user's.
    expect((await answerRows(ownerAnswer.runId)).map(({ bookmark_id }) => bookmark_id)).toEqual([
      mine,
    ]);
    expect((await answerRows(secondAnswer.runId)).map(({ bookmark_id }) => bookmark_id)).toEqual([
      theirs,
    ]);
    const { results: runs } = await DB.prepare("SELECT id, user_id FROM search_runs").all();
    expect(
      Object.fromEntries(runs.map((run: { id: string; user_id: string }) => [run.id, run.user_id])),
    ).toEqual({ [ownerAnswer.runId]: owner.userId, [secondAnswer.runId]: second.userId });
  });

  // The user is the session's. A user ID in the body is not read.
  it("takes the user from the session, never from the body", async () => {
    const DB = await d1();
    const second = await seedSignedInUser(DB, "second@example.com");
    await saveEnrichedFor(second.userId, "theirs", 2_000);
    await saveEnrichedFor(owner.userId, "mine", 1_000);
    fixture.respond(
      answerBy({ theirs: { noul: 0.9, score: 2.8 }, mine: { noul: 0.9, score: 2.8 } }),
    );

    const answer = await answerOf(await postAsOwner({ query: QUERY, userId: second.userId }));

    expect(answer.results.map(({ title }) => title)).toEqual(["Title mine"]);
    const { results } = await DB.prepare("SELECT user_id FROM search_runs").all();
    expect(results).toEqual([{ user_id: owner.userId }]);
  });

  it("answers 401, not a redirect, to a request without a session, and does nothing", async () => {
    await saveEnrichedFor(owner.userId, "found", 1_000);
    const response = await post({ origin });
    expect(response.status).toBe(401);
    expect(response.headers.has("location")).toBe(false);
    expect(await response.text()).toBe("Unauthorized");
    expect(fixture.requests).toEqual([]);
    expect(await tableCounts()).toEqual({ runs: 0, answers: 0 });
  });

  it("answers 401 to a session that isn't valid, and clears its cookie", async () => {
    const response = await post({ origin, cookie: "__Host-session=not-a-session" });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("__Host-session=;");
    expect(fixture.requests).toEqual([]);
  });

  it.each([
    ["from another origin", { origin: "https://evil.test" }],
    ["with no Origin header", {}],
  ])("answers 403 to a request %s, even with a session, and does nothing", async (_, headers) => {
    await saveEnrichedFor(owner.userId, "found", 1_000);
    const response = await post({ cookie: owner.cookie, ...headers });
    expect(response.status).toBe(403);
    expect(fixture.requests).toEqual([]);
    expect(await tableCounts()).toEqual({ runs: 0, answers: 0 });
  });

  it("answers 403 to a request from another origin that has no session either, before the session check", async () => {
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
  });

  it("has no route for GET", async () => {
    const response = await server.fetch("/api/search", {
      headers: { accept: "application/json", cookie: owner.cookie },
    });
    expect(response.status).toBe(404);
  });

  it("answers JSON with the headers every body gets", async () => {
    await saveEnrichedFor(owner.userId, "found", 1_000);
    fixture.respond(answerBy());
    const response = await postAsOwner();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// The route passes `request.signal` on, which never aborts under a compatibility date before
// 2026-11-17 unless the flag is set (wrangler.jsonc). Neither the test harness nor Miniflare
// delivers a client's disconnect to the Worker (see the plan, "Search page"), so this checks the
// configuration that production reads, and the fake-service tests above check what the route
// does with the signal.
describe("the Worker's configuration", () => {
  it("turns on request.signal, which the route passes on, until it is on by default", async () => {
    const jsonc = withoutJsoncComments(
      await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    );
    const date = /"compatibility_date"\s*:\s*"([^"]+)"/.exec(jsonc)?.[1] ?? "";
    const flags = /"compatibility_flags"\s*:\s*\[([^\]]*)\]/.exec(jsonc)?.[1] ?? "";
    const onByDefault = date >= "2026-11-17";
    expect(onByDefault || flags.includes('"enable_request_signal"')).toBe(true);
    expect(flags).not.toContain("disable_request_signal");
  });
});
