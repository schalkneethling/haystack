// Search's request to Jev (#210): its shape, which questions it asks, how its answers are
// validated, and its retries and failures. Every request is answered by the Jev fixture
// (jev-fixture.ts), which fails a test that makes a request it did not plan for, so no test calls
// TypeSafe. See "Question design" and "Jev client" in plans/haystack-v1-implementation-plan.md.
import { delay, HttpResponse, type JsonBodyType } from "msw";
import * as v from "valibot";
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
import {
  askSearch,
  RELEVANCE_SCORE_MAX,
  RelevanceAnswer,
  relevanceQuestion,
  SEARCH_TIMING,
  type SearchAsk,
  type SearchBookmark,
  type SearchQuestions,
} from "../src/search/jev-search.ts";
import {
  answer,
  JEV_ORIGIN,
  type JevFixture,
  type JevResolver,
  networkError,
  startJevFixture,
  status,
  SYSTEM_ONE_URL,
} from "./jev-fixture.ts";

// Not a real key: a string that appears nowhere else, so finding it anywhere is a leak.
const KEY = "ts-search-key-4e8b2d7a";

const config: JevConfig = {
  JEV_BASE_URL: JEV_ORIGIN,
  JEV_MODEL: "jev-1.14.0",
  TYPESAFE_API_KEY: KEY,
};

// SEARCH_TIMING with shorter waits, to keep the tests fast. Its attempt limit is search's own, so
// a change to SEARCH_TIMING's limit changes how many attempts the retry tests expect.
const timing: JevTiming = { ...SEARCH_TIMING, attemptTimeoutMs: 100, backoffInitialMs: 1 };

// Bookmark IDs as the database makes them, with crypto.randomUUID().
const BOOKMARKS: readonly SearchBookmark[] = [
  {
    id: "5f0c3a52-8d1e-4b7a-9c2f-1e6d4a8b3c70",
    title: "Vitest",
    kind: "tool",
    matchText: "Vitest. A Vite-native test runner for JavaScript and TypeScript.",
  },
  {
    id: "a9e47b13-26c8-4f05-b1d3-7c85e2f09a64",
    title: "Baking sourdough at home",
    kind: "tutorial",
    matchText: "Baking sourdough at home. A step-by-step guide to a starter and a first loaf.",
  },
];

const QUERY = "a test runner for a Vite project";

function ask(questions: SearchQuestions = "both", signal?: AbortSignal) {
  return askSearch(config, { query: QUERY, bookmarks: BOOKMARKS, questions }, timing, signal);
}

/**
 * A `relevance` answer in the shape of the API reference's Score example and the Score page's
 * recorded responses (https://docs.typesafe.ai/primitives/score.md, read on 2026-11-01), over
 * this request's four levels. The probabilities are the plan's worked example, so `score` is their
 * weighted mean: 0 × 0.1 + 1 × 0.1 + 2 × 0.2 + 3 × 0.6 = 2.3. No live answer was recorded, because
 * no test calls TypeSafe.
 */
const RELEVANCE = {
  type: "score",
  score: 2.3,
  confidence: 0.41,
  legend: {
    "0": "Unrelated to the need",
    "1": "Same general area, but would not help with this specific need",
    "2": "Partially addresses the need, or is one of several reasonable options",
    "3": "Directly addresses the need",
  },
  probabilities: { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.6 },
};

const LOW_RELEVANCE = {
  ...RELEVANCE,
  score: 0.15,
  confidence: 0.86,
  probabilities: { "0": 0.9, "1": 0.06, "2": 0.03, "3": 0.01 },
};

/** Jev's answer to both questions about both bookmarks. */
const BOTH_RESPONSE = {
  model: "jev-1.14.0",
  answers: {
    b_0_helps: { type: "noul", noul: 0.93 },
    b_0_relevance: RELEVANCE,
    b_1_helps: { type: "noul", noul: 0.02 },
    b_1_relevance: LOW_RELEVANCE,
  },
  usage: { input_tokens: 874, output_tokens: 61 },
};

// BOTH_RESPONSE with `answers` changed by `change`.
function withAnswers(
  change: (answers: Record<string, unknown>) => Record<string, unknown>,
): JsonBodyType {
  return { ...BOTH_RESPONSE, answers: change({ ...BOTH_RESPONSE.answers }) } as JsonBodyType;
}

// BOTH_RESPONSE without the answer to question `id`.
function withoutAnswer(id: string): JsonBodyType {
  return withAnswers((answers) => {
    const { [id]: _, ...rest } = answers;
    return rest;
  });
}

interface SentBody {
  readonly model: string;
  readonly state: {
    readonly query: string;
    readonly bookmarks: Record<string, Record<string, unknown>>;
  };
  readonly questions: Record<
    string,
    { readonly type: string; readonly instructions: string; readonly criteria: unknown }
  >;
}

function sentBody(index = 0): SentBody {
  return JSON.parse(fixture.requests[index]?.body ?? "") as SentBody;
}

// The alias the question's instructions name, from its backticked path.
function pathIn(instructions: string): string | undefined {
  return /`bookmarks\.([^`]+)`/.exec(instructions)?.[1];
}

let fixture: JevFixture;
const consoleMethods = ["debug", "error", "info", "log", "trace", "warn"] as const;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeAll(() => {
  fixture = startJevFixture();
});

afterAll(() => {
  fixture.close();
});

beforeEach(() => {
  fixture.reset();
  consoleSpies = consoleMethods.map((method) => vi.spyOn(console, method));
});

afterEach(() => {
  // No test makes a request that the fixture didn't plan for, so none reaches the network.
  expect(fixture.unplanned).toEqual([]);
  // The client logs nothing, so it can't log the key.
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
  vi.restoreAllMocks();
});

describe("askSearch", () => {
  describe("the request", () => {
    it("posts the model, the query and each bookmark's title, kind and match_text, and nothing else", async () => {
      // A caller may hand over more than the three fields, such as a row from the database. None
      // of it is sent, nor the bookmark's ID.
      const rows = BOOKMARKS.map((bookmark) => ({
        ...bookmark,
        url: `https://example.test/${bookmark.id}`,
        description: "Not to be sent",
      }));
      fixture.respond(answer(BOTH_RESPONSE));
      await askSearch(config, { query: QUERY, bookmarks: rows, questions: "both" }, timing);
      expect(fixture.requests).toHaveLength(1);
      const [request] = fixture.requests;
      expect(request?.url).toBe(SYSTEM_ONE_URL);
      expect(request?.method).toBe("POST");
      expect(request?.headers.get("content-type")).toBe("application/json");
      // Phase 11 sends no long-context header (see "Jev model limits").
      expect(request?.headers.has("typesafe-danger-zone-long-context")).toBe(false);
      const body = sentBody();
      expect(Object.keys(body)).toEqual(["model", "state", "questions"]);
      expect(body.model).toBe("jev-1.14.0");
      expect(body.state).toEqual({
        query: QUERY,
        bookmarks: {
          b_0: { title: "Vitest", kind: "tool", match_text: BOOKMARKS[0]?.matchText },
          b_1: {
            title: "Baking sourdough at home",
            kind: "tutorial",
            match_text: BOOKMARKS[1]?.matchText,
          },
        },
      });
      for (const row of rows) {
        expect(request?.body).not.toContain(row.id);
        expect(request?.body).not.toContain(row.url);
        expect(request?.body).not.toContain(row.description);
      }
    });

    it("words each question as in Question design, naming its bookmark by path", async () => {
      fixture.respond(answer(BOTH_RESPONSE));
      await ask();
      expect(sentBody().questions).toEqual({
        b_0_helps: {
          type: "noul",
          instructions: "Would `bookmarks.b_0` help the person with what `query` describes?",
          criteria: {
            true: "The bookmark directly serves the need in the query.",
            false: "The bookmark is only on a related topic, or unrelated.",
          },
        },
        b_0_relevance: {
          type: "score",
          instructions: "How well does `bookmarks.b_0` serve the need described in `query`?",
          criteria: [
            "Unrelated to the need",
            "Same general area, but would not help with this specific need",
            "Partially addresses the need, or is one of several reasonable options",
            "Directly addresses the need",
          ],
        },
        b_1_helps: expect.objectContaining({
          type: "noul",
          instructions: "Would `bookmarks.b_1` help the person with what `query` describes?",
        }),
        b_1_relevance: expect.objectContaining({
          type: "score",
          instructions: "How well does `bookmarks.b_1` serve the need described in `query`?",
        }),
      });
    });

    it("asks only the Noul with `noul`, and returns no Score", async () => {
      fixture.respond(
        answer(withAnswers(({ b_0_helps, b_1_helps }) => ({ b_0_helps, b_1_helps }))),
      );
      const result = await ask("noul");
      expect(Object.values(sentBody().questions).map(({ type }) => type)).toEqual(["noul", "noul"]);
      expect(result).toMatchObject({
        ok: true,
        answer: [
          { bookmarkId: BOOKMARKS[0]?.id, noul: 0.93, score: null },
          { bookmarkId: BOOKMARKS[1]?.id, noul: 0.02, score: null },
        ],
      });
    });

    it("asks only the Score with `score`, and returns no Noul", async () => {
      fixture.respond(
        answer(
          withAnswers(({ b_0_relevance, b_1_relevance }) => ({ b_0_relevance, b_1_relevance })),
        ),
      );
      const result = await ask("score");
      expect(Object.values(sentBody().questions).map(({ type }) => type)).toEqual([
        "score",
        "score",
      ]);
      expect(result).toMatchObject({
        ok: true,
        answer: [
          { bookmarkId: BOOKMARKS[0]?.id, noul: null, score: { score: 2.3 } },
          { bookmarkId: BOOKMARKS[1]?.id, noul: null, score: { score: 0.15 } },
        ],
      });
    });

    it("asks both questions about each bookmark with `both`", async () => {
      fixture.respond(answer(BOTH_RESPONSE));
      await ask("both");
      expect(Object.keys(sentBody().questions)).toEqual([
        "b_0_helps",
        "b_0_relevance",
        "b_1_helps",
        "b_1_relevance",
      ]);
    });

    // A bookmark's ID is a UUID, and the documentation gives no grammar for a path through a key
    // with hyphens, so each bookmark is named by an alias. The fixture answers from what it was
    // sent: each question's answer depends on the title at the path its instructions name, so a
    // question that pointed at the wrong bookmark would hand that bookmark's answer to another.
    it("names each bookmark by a path that leads to it, and maps the answers back to its ID", async () => {
      const titles = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
      const bookmarks: SearchBookmark[] = titles.map((title) => ({
        id: crypto.randomUUID(),
        title,
        kind: "article",
        matchText: `${title}.`,
      }));
      const nouls: Record<string, number> = {
        Alpha: 0.1,
        Bravo: 0.3,
        Charlie: 0.5,
        Delta: 0.7,
        Echo: 0.9,
      };
      const scored: JevResolver = async (request) => {
        const body = (await request.json()) as SentBody;
        const answers: Record<string, unknown> = {};
        for (const [id, question] of Object.entries(body.questions)) {
          const alias = pathIn(question.instructions) ?? "";
          const title = String(body.state.bookmarks[alias]?.title);
          const noul = nouls[title] ?? Number.NaN;
          answers[id] =
            question.type === "noul"
              ? { type: "noul", noul }
              : {
                  ...RELEVANCE,
                  score: 3 * noul,
                  probabilities: { "0": 1 - noul, "1": 0, "2": 0, "3": noul },
                };
        }
        return HttpResponse.json({ ...BOTH_RESPONSE, answers });
      };
      fixture.respond(scored);
      const result = await askSearch(
        config,
        { query: QUERY, bookmarks, questions: "both" },
        timing,
      );
      expect(result.ok).toBe(true);
      expect(result.ok && result.answer).toEqual(
        bookmarks.map(({ id, title }) => ({
          bookmarkId: id,
          noul: nouls[title],
          score: expect.objectContaining({ score: 3 * (nouls[title] ?? 0) }),
        })),
      );
      // Every path names a bookmark in the state, and every bookmark is named by its two
      // questions.
      const body = sentBody();
      const byName = (a: string, b: string) => a.localeCompare(b);
      const named = Object.values(body.questions).map(({ instructions }) =>
        String(pathIn(instructions)),
      );
      expect(named.toSorted(byName)).toEqual(
        Object.keys(body.state.bookmarks)
          .flatMap((alias) => [alias, alias])
          .toSorted(byName),
      );
      for (const { id } of bookmarks) {
        expect(fixture.requests[0]?.body).not.toContain(id);
      }
    });

    it.each([
      ["no bookmarks", []],
      ["a bookmark given twice", [BOOKMARKS[0], BOOKMARKS[0]]],
    ])("refuses %s, before anything is sent", async (_, bookmarks) => {
      await expect(
        askSearch(
          config,
          { query: QUERY, bookmarks: bookmarks as SearchBookmark[], questions: "both" },
          timing,
        ),
      ).rejects.toThrow(RangeError);
      expect(fixture.requests).toEqual([]);
    });
  });

  describe("the answers", () => {
    it("returns each bookmark's Noul and Score apart, the model and the input tokens", async () => {
      fixture.respond(answer(BOTH_RESPONSE));
      expect(await ask()).toEqual({
        ok: true,
        answer: [
          {
            bookmarkId: BOOKMARKS[0]?.id,
            noul: 0.93,
            score: {
              score: 2.3,
              probabilities: { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.6 },
              confidence: 0.41,
            },
          },
          {
            bookmarkId: BOOKMARKS[1]?.id,
            noul: 0.02,
            score: {
              score: 0.15,
              probabilities: { "0": 0.9, "1": 0.06, "2": 0.03, "3": 0.01 },
              confidence: 0.86,
            },
          },
        ],
        model: "jev-1.14.0",
        inputTokens: 874,
        attempts: 1,
      });
    });

    // The client keeps what the API returns and derives no number of its own. That `score` is the
    // weighted mean of the levels is the API's definition, which the example follows.
    it("keeps the Score's score, probabilities and confidence as returned", async () => {
      fixture.respond(answer(BOTH_RESPONSE));
      const result = await ask();
      if (!result.ok) {
        throw new Error("The search failed");
      }
      // That `score` is the weighted mean of the levels is a property of the API's answer, which
      // Haystack doesn't compute. The recorded example that shows it has three levels, so it is
      // in jev-client.test.ts ("keeps the Score page's recorded answer as returned").
      for (const [index, returned] of [RELEVANCE, LOW_RELEVANCE].entries()) {
        expect(result.answer[index]?.score).toEqual({
          score: returned.score,
          probabilities: returned.probabilities,
          confidence: returned.confidence,
        });
      }
    });

    const invalid: [string, JsonBodyType][] = [
      [
        "a Noul above 1",
        withAnswers((answers) => ({ ...answers, b_1_helps: { type: "noul", noul: 1.01 } })),
      ],
      [
        "a Noul below 0",
        withAnswers((answers) => ({ ...answers, b_0_helps: { type: "noul", noul: -0.2 } })),
      ],
      [
        "a Noul that isn't a number",
        withAnswers((answers) => ({ ...answers, b_0_helps: { type: "noul", noul: "0.9" } })),
      ],
      ["a missing Noul for one bookmark", withoutAnswer("b_1_helps")],
      ["a missing Score for one bookmark", withoutAnswer("b_0_relevance")],
      [
        "a Score where a Noul was asked",
        withAnswers((answers) => ({ ...answers, b_0_helps: RELEVANCE })),
      ],
      [
        "a Noul where a Score was asked",
        withAnswers((answers) => ({ ...answers, b_1_relevance: { type: "noul", noul: 0.4 } })),
      ],
      [
        "a Score whose probabilities leave out a level",
        withAnswers((answers) => ({
          ...answers,
          b_0_relevance: { ...RELEVANCE, probabilities: { "0": 0.2, "1": 0.2, "2": 0.6 } },
        })),
      ],
      [
        "a Score whose probabilities add a level",
        withAnswers((answers) => ({
          ...answers,
          b_0_relevance: {
            ...RELEVANCE,
            probabilities: { ...RELEVANCE.probabilities, "4": 0 },
          },
        })),
      ],
      [
        "a Score whose probabilities are keyed by description",
        withAnswers((answers) => ({
          ...answers,
          b_0_relevance: {
            ...RELEVANCE,
            probabilities: Object.fromEntries(
              Object.entries(RELEVANCE.probabilities).map(([level, probability]) => [
                RELEVANCE.legend[level as keyof typeof RELEVANCE.legend],
                probability,
              ]),
            ),
          },
        })),
      ],
      [
        "a Score with a probability above 1",
        withAnswers((answers) => ({
          ...answers,
          b_0_relevance: { ...RELEVANCE, probabilities: { ...RELEVANCE.probabilities, "3": 1.6 } },
        })),
      ],
      [
        "a Score above the top level",
        withAnswers((answers) => ({ ...answers, b_0_relevance: { ...RELEVANCE, score: 3.2 } })),
      ],
      [
        "a Score without its confidence",
        withAnswers((answers) => {
          const { confidence: _, ...relevance } = RELEVANCE;
          return { ...answers, b_0_relevance: relevance };
        }),
      ],
      ["no answers at all", withAnswers(() => ({}))],
      ["no usage", { model: BOTH_RESPONSE.model, answers: BOTH_RESPONSE.answers }],
      ["fractional input tokens", { ...BOTH_RESPONSE, usage: { input_tokens: 87.5 } }],
      ["no model", { answers: BOTH_RESPONSE.answers, usage: BOTH_RESPONSE.usage }],
      ["a body that isn't JSON", "not json"],
    ];
    for (const [name, body] of invalid) {
      it(`makes the whole request invalid for ${name}, without retrying it`, async () => {
        fixture.respond(() =>
          typeof body === "string" ? HttpResponse.text(body) : HttpResponse.json(body),
        );
        expect(await ask()).toEqual({
          ok: false,
          failure: "permanent",
          reason: "invalid-response",
          attempts: 1,
        });
        expect(fixture.requests).toHaveLength(1);
      });
    }

    // A Score answer for a question that wasn't asked isn't read, so it can't fail the request.
    it("ignores an answer to a question that wasn't asked", async () => {
      fixture.respond(
        answer(
          withAnswers(({ b_0_helps, b_1_helps }) => ({
            b_0_helps,
            b_1_helps,
            b_0_relevance: "not a Score",
          })),
        ),
      );
      expect(await ask("noul")).toMatchObject({ ok: true });
    });
  });

  describe("retries", () => {
    it("makes at most 3 attempts, as the client does for a question", () => {
      expect(SEARCH_TIMING.attemptLimit).toBe(3);
    });

    for (const code of [429, 529, 500, 503]) {
      it(`retries a ${code} and succeeds on the next attempt`, async () => {
        fixture.respond(status(code), answer(BOTH_RESPONSE));
        expect(await ask()).toMatchObject({ ok: true, attempts: 2 });
        expect(fixture.requests).toHaveLength(2);
      });
    }

    // `timing` carries SEARCH_TIMING's attempt limit, so a lower limit there fails this test.
    it("stops after 3 attempts of 429, 529 and 503, and the failure is transient", async () => {
      fixture.respond(status(429), status(529), status(503));
      expect(await ask()).toEqual({
        ok: false,
        failure: "transient",
        reason: "status",
        status: 503,
        attempts: 3,
      });
      expect(fixture.requests).toHaveLength(3);
    });

    for (const code of [400, 404, 413, 422]) {
      it(`doesn't retry a ${code}, which is permanent`, async () => {
        fixture.respond(status(code));
        expect(await ask()).toEqual({
          ok: false,
          failure: "permanent",
          reason: "status",
          status: code,
          attempts: 1,
        });
        expect(fixture.requests).toHaveLength(1);
      });
    }

    it("doesn't retry a 401, which is the account's failure", async () => {
      fixture.respond(status(401));
      expect(await ask()).toEqual({
        ok: false,
        failure: "account",
        reason: "status",
        status: 401,
        attempts: 1,
      });
    });
  });

  describe("the key", () => {
    it("is sent only in the authorization header, only to the configured base URL", async () => {
      fixture.respond(status(429), answer(BOTH_RESPONSE));
      await ask();
      expect(fixture.requests).toHaveLength(2);
      for (const request of fixture.requests) {
        expect(new URL(request.url).origin).toBe(JEV_ORIGIN);
        expect(request.url).not.toContain(KEY);
        expect(request.body).not.toContain(KEY);
        for (const [name, value] of request.headers) {
          expect(value.includes(KEY)).toBe(name === "authorization");
        }
        expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      }
    });

    // Each failure reason, with a response that repeats the key where a body or a header could.
    // Nothing is logged (afterEach), and the result, which a caller may log, holds a fixed code.
    const echoed = { detail: `Invalid key ${KEY}` };
    const slow: JevResolver = async () => {
      await delay(timing.attemptTimeoutMs * 5);
      return HttpResponse.json(echoed);
    };
    const failures: [string, JevResolver[], string][] = [
      ["timeout", [slow, slow, slow], "timeout"],
      ["network", [networkError, networkError, networkError], "network"],
      [
        "status",
        [() => HttpResponse.json(echoed, { status: 401, headers: { "x-echo": KEY } })],
        "status",
      ],
      ["invalid-response", [() => HttpResponse.json(echoed)], "invalid-response"],
    ];
    for (const [name, resolvers, reason] of failures) {
      it(`is in no result or log for a ${name} failure`, async () => {
        fixture.respond(...resolvers);
        const result = await ask();
        expect(result).toMatchObject({ ok: false, reason });
        expect(JSON.stringify(result)).not.toContain(KEY);
      });
    }

    it("is in no error for a configuration that refuses to send it", async () => {
      const error = await askSearch(
        { ...config, JEV_BASE_URL: "http://jev.test" },
        { query: QUERY, bookmarks: BOOKMARKS, questions: "both" } satisfies SearchAsk,
        timing,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "JEV_BASE_URL_INVALID" });
      expect(JSON.stringify(error)).not.toContain(KEY);
      expect(String(error)).not.toContain(KEY);
      expect(fixture.requests).toEqual([]);
    });
  });
});

// The Score threshold's range ends at RELEVANCE_SCORE_MAX (flags.ts, #255), so it has to follow
// the relevance question's levels: a level added or removed moves it.
describe("RELEVANCE_SCORE_MAX", () => {
  // All the probability on the last level, built from the levels, so that a change to their
  // number fails on the score's range, not on the probabilities' keys.
  const top = Object.fromEntries(
    Array.from({ length: RELEVANCE_SCORE_MAX + 1 }, (_, level) => [
      String(level),
      level === RELEVANCE_SCORE_MAX ? 1 : 0,
    ]),
  );
  const answer = (score: number) => ({ type: "score", score, confidence: 0.9, probabilities: top });

  it("is 3 with the relevance question's four levels", () => {
    expect(relevanceQuestion("b_0").criteria).toHaveLength(4);
    expect(RELEVANCE_SCORE_MAX).toBe(3);
  });

  // RelevanceAnswer gets its maximum from the number of levels on its own path (scoreAnswer in
  // jev-client.ts), so this is the check that ties the two together.
  it("is the highest score a relevance answer can have", () => {
    expect(v.safeParse(RelevanceAnswer, answer(RELEVANCE_SCORE_MAX)).success).toBe(true);
    expect(v.safeParse(RelevanceAnswer, answer(RELEVANCE_SCORE_MAX + 0.001)).success).toBe(false);
  });
});
