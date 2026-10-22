// The Jev client (#122): retries, how failures are classified, and where the key goes. Every
// request is answered by the Jev fixture (jev-fixture.ts), which fails a test that makes a
// request it did not plan for. See "Jev client" and Q3 in plans/haystack-v1-implementation-plan.md.
import { delay, HttpResponse, type JsonBodyType } from "msw";
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
import {
  askJev,
  JEV_ATTEMPT_LIMIT,
  type JevConfig,
  type JevResult,
  type JevTiming,
  NoulAnswer,
} from "../src/enrichment/jev-client.ts";
import {
  answer,
  JEV_ORIGIN,
  type JevFixture,
  networkError,
  startJevFixture,
  status,
  SYSTEM_ONE_URL,
} from "./jev-fixture.ts";

// Not a real key: a string that appears nowhere else, so finding it anywhere is a leak.
const KEY = "ts-test-key-7f3a9c1e";

const config: JevConfig = {
  JEV_BASE_URL: JEV_ORIGIN,
  JEV_MODEL: "jev-1.13.0",
  TYPESAFE_API_KEY: KEY,
};

// Short enough to keep the tests fast, long enough for a delayed fixture response to miss it.
const timing: JevTiming = { attemptTimeoutMs: 100, backoffInitialMs: 1 };

// A response in the shape of the Noul page's jev-1.13.0 example.
const noulResponse = {
  model: "jev-1.13.0",
  answers: { billing: { type: "noul", noul: 0.98 } },
  usage: { input_tokens: 120, output_tokens: 12 },
};

function ask(): Promise<JevResult<number>> {
  return askJev(
    config,
    {
      state: "I was charged twice for my subscription this month.",
      id: "billing",
      question: { type: "noul", instructions: "Is this message about billing?" },
      answer: NoulAnswer,
    },
    timing,
  );
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
});

describe("askJev", () => {
  it("returns the answer, the model that answered and the input tokens", async () => {
    fixture.respond(answer(noulResponse));
    expect(await ask()).toEqual({
      ok: true,
      answer: 0.98,
      model: "jev-1.13.0",
      inputTokens: 120,
      attempts: 1,
    });
  });

  it("posts the model, the state and the question to /v1/systemone", async () => {
    fixture.respond(answer(noulResponse));
    await ask();
    expect(fixture.requests).toHaveLength(1);
    const [request] = fixture.requests;
    expect(request?.url).toBe(SYSTEM_ONE_URL);
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(request?.body ?? "")).toEqual({
      model: "jev-1.13.0",
      state: "I was charged twice for my subscription this month.",
      questions: { billing: { type: "noul", instructions: "Is this message about billing?" } },
    });
  });

  describe("retries", () => {
    for (const code of [429, 529]) {
      it(`succeeds after a ${code}`, async () => {
        fixture.respond(status(code), answer(noulResponse));
        const result = await ask();
        expect(result).toMatchObject({ ok: true, answer: 0.98, attempts: 2 });
        expect(fixture.requests).toHaveLength(2);
      });
    }

    it("makes exactly 3 requests for three 429s, and the failure is transient", async () => {
      fixture.respond(status(429), status(429), status(429));
      expect(await ask()).toEqual({
        ok: false,
        failure: "transient",
        reason: "status",
        status: 429,
        attempts: JEV_ATTEMPT_LIMIT,
      });
      expect(fixture.requests).toHaveLength(3);
    });

    it("retries a 5xx, a 408 and a network error within the same 3 attempts", async () => {
      fixture.respond(status(503), networkError, status(408));
      expect(await ask()).toEqual({
        ok: false,
        failure: "transient",
        reason: "status",
        status: 408,
        attempts: 3,
      });
      expect(fixture.requests).toHaveLength(3);
    });

    it("doubles the delay between attempts", async () => {
      const backoffInitialMs = 40;
      const arrivals: number[] = [];
      const timed = (code: number) => () => {
        arrivals.push(performance.now());
        return HttpResponse.json({}, { status: code });
      };
      fixture.respond(timed(429), timed(429), timed(429));
      await askJev(
        config,
        {
          state: "x",
          id: "billing",
          question: { type: "noul", instructions: "?" },
          answer: NoulAnswer,
        },
        { ...timing, backoffInitialMs },
      );
      const [first = 0, second = 0, third = 0] = arrivals;
      // Up to a quarter of each delay is taken off at random, so the first waits at least 30 ms
      // and the second at least 60 ms. A timer can fire a millisecond early.
      expect(second - first).toBeGreaterThanOrEqual(backoffInitialMs * 0.75 - 1);
      expect(third - second).toBeGreaterThanOrEqual(backoffInitialMs * 1.5 - 1);
    });

    it("waits as long as retry-after-ms asks, when that is longer than the backoff", async () => {
      const arrivals: number[] = [];
      fixture.respond(
        () => {
          arrivals.push(performance.now());
          return HttpResponse.json({}, { status: 429, headers: { "retry-after-ms": "60" } });
        },
        () => {
          arrivals.push(performance.now());
          return HttpResponse.json(noulResponse);
        },
      );
      expect(await ask()).toMatchObject({ ok: true, attempts: 2 });
      const [first = 0, second = 0] = arrivals;
      expect(second - first).toBeGreaterThanOrEqual(59);
    });

    it("stops when Retry-After asks for a longer wait than it allows", async () => {
      fixture.respond(status(429, { "retry-after": "120" }));
      expect(await ask()).toEqual({
        ok: false,
        failure: "transient",
        reason: "status",
        status: 429,
        attempts: 1,
      });
      expect(fixture.requests).toHaveLength(1);
    });
  });

  describe("failures", () => {
    it("makes a 400 permanent, without retrying it", async () => {
      fixture.respond(status(400));
      expect(await ask()).toEqual({
        ok: false,
        failure: "permanent",
        reason: "status",
        status: 400,
        attempts: 1,
      });
      expect(fixture.requests).toHaveLength(1);
    });

    it("makes a network error transient", async () => {
      fixture.respond(networkError, networkError, networkError);
      expect(await ask()).toEqual({
        ok: false,
        failure: "transient",
        reason: "network",
        attempts: 3,
      });
      expect(fixture.requests).toHaveLength(3);
    });

    it("makes a timeout transient, and counts it as one of the 3 attempts", async () => {
      const slow = async () => {
        await delay(timing.attemptTimeoutMs * 5);
        return HttpResponse.json(noulResponse);
      };
      fixture.respond(slow, slow, slow);
      expect(await ask()).toEqual({
        ok: false,
        failure: "transient",
        reason: "timeout",
        attempts: 3,
      });
      expect(fixture.requests).toHaveLength(3);
    });

    it("answers on the attempt after a timeout", async () => {
      fixture.respond(async () => {
        await delay(timing.attemptTimeoutMs * 5);
        return HttpResponse.json(noulResponse);
      }, answer(noulResponse));
      expect(await ask()).toMatchObject({ ok: true, answer: 0.98, attempts: 2 });
    });

    const invalid: [string, JsonBodyType][] = [
      ["a body that isn't JSON", "not json"],
      ["a missing answer", { ...noulResponse, answers: { other: { type: "noul", noul: 0.5 } } }],
      ["an answer of another type", { ...noulResponse, answers: { billing: { type: "choice" } } }],
      [
        "a probability above 1",
        { ...noulResponse, answers: { billing: { type: "noul", noul: 1.2 } } },
      ],
      ["no usage", { model: noulResponse.model, answers: noulResponse.answers }],
      ["fractional input tokens", { ...noulResponse, usage: { input_tokens: 1.5 } }],
      ["no model", { answers: noulResponse.answers, usage: noulResponse.usage }],
    ];
    for (const [name, body] of invalid) {
      it(`makes ${name} a permanent failure, without retrying it`, async () => {
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
  });

  describe("the key", () => {
    it("is sent only in the authorization header, only to the configured base URL", async () => {
      fixture.respond(status(429), status(503), answer(noulResponse));
      await ask();
      expect(fixture.requests).toHaveLength(3);
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

    it("is not sent on to a redirect's target", async () => {
      fixture.respond(() =>
        HttpResponse.json(
          {},
          { status: 307, headers: { location: "https://elsewhere.test/v1/systemone" } },
        ),
      );
      // A followed redirect would reach elsewhere.test, which the fixture records as unplanned.
      expect(await ask()).toMatchObject({ ok: false, failure: "permanent", attempts: 1 });
      expect(fixture.requests).toHaveLength(1);
    });

    it("is not in any result, which callers may log", async () => {
      fixture.respond(status(401), answer(noulResponse));
      const failure = await ask();
      const success = await ask();
      expect(JSON.stringify([failure, success])).not.toContain(KEY);
    });

    it("must not be empty, and nothing is sent without one", async () => {
      await expect(
        askJev(
          { ...config, TYPESAFE_API_KEY: " " },
          {
            state: "x",
            id: "billing",
            question: { type: "noul", instructions: "?" },
            answer: NoulAnswer,
          },
        ),
      ).rejects.toThrow("TYPESAFE_API_KEY is empty");
      expect(fixture.requests).toEqual([]);
    });

    it("is sent only over https", async () => {
      await expect(
        askJev(
          { ...config, JEV_BASE_URL: "http://jev.test" },
          {
            state: "x",
            id: "billing",
            question: { type: "noul", instructions: "?" },
            answer: NoulAnswer,
          },
        ),
      ).rejects.toThrow("JEV_BASE_URL must be an https URL");
      expect(fixture.requests).toEqual([]);
    });
  });
});
