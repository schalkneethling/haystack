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
  assertJevConfig,
  JEV_ATTEMPT_LIMIT,
  JEV_MAX_RETRY_DELAY_MS,
  type JevConfig,
  type JevResult,
  type JevTiming,
  NoulAnswer,
} from "../src/enrichment/jev-client.ts";
import {
  answer,
  JEV_LOOPBACK_ORIGIN,
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

// The waits the client asks for between attempts, in milliseconds, as it calls them. Only the
// timers that jev-client.ts's `sleep` sets are recorded, because Node's fetch sets timers of its
// own around each request, some while the client's own frames are on the stack, so the match
// names `sleep` and not only the file. Every timer still runs as asked, with all its arguments:
// fetch's keep-alive timer passes its state as a third one. With `skipWaits`, the client's own
// waits run at once instead, for a test of a delay too long to wait out (#142).
function recordClientWaits({ skipWaits = false } = {}): number[] {
  const waits: number[] = [];
  const setTimeoutAsGiven = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (...args: Parameters<typeof setTimeout>) => {
      // The default limit of 10 frames leaves `sleep` only a few frames from being cut off.
      const stackTraceLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 50;
      const stack = new Error().stack ?? "";
      Error.stackTraceLimit = stackTraceLimit;
      if (/\bsleep \([^)]*src[\\/]enrichment[\\/]jev-client\.ts/.test(stack)) {
        waits.push(args[1] ?? 0);
        if (skipWaits) {
          const [callback, , ...rest] = args;
          return setTimeoutAsGiven(callback, 0, ...rest);
        }
      }
      return setTimeoutAsGiven(...args);
    },
  );
  return waits;
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

    it("doubles the delay between attempts, and takes the jitter off it", async () => {
      // With the random draw at 0.99, the jitter takes 24.75% off each delay: 75.25 ms before the
      // second attempt and 150.5 ms before the third. Jitter added instead would make them about
      // 125 ms and 250 ms, and no doubling would make the second 75.25 ms. The delays the client
      // asks for are read from its timer, because a busy machine fires a timer late by any
      // amount (up to 310 ms was seen), so an upper bound on the time between requests fails
      // although the client is right. The arrivals still show that it waited.
      const backoffInitialMs = 100;
      vi.spyOn(Math, "random").mockReturnValue(0.99);
      const waits = recordClientWaits();
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
      expect(waits).toEqual([backoffInitialMs * 0.7525, backoffInitialMs * 2 * 0.7525]);
      const [first = 0, second = 0, third = 0] = arrivals;
      // A timer can fire a millisecond early.
      expect(second - first).toBeGreaterThanOrEqual(backoffInitialMs * 0.7525 - 1);
      expect(third - second).toBeGreaterThanOrEqual(backoffInitialMs * 2 * 0.7525 - 1);
    });

    it("cuts a backoff longer than 5 seconds to JEV_MAX_RETRY_DELAY_MS", async () => {
      // With the random draw at 0, the jitter takes nothing off, so the first delay is 0.8 of the
      // cap, under it, and the second doubles it to 1.6 of the cap, which the cap cuts. The waits
      // run at once, so the test reads the delays it asks for without waiting them out (#142).
      const backoffInitialMs = JEV_MAX_RETRY_DELAY_MS * 0.8;
      vi.spyOn(Math, "random").mockReturnValue(0);
      const waits = recordClientWaits({ skipWaits: true });
      fixture.respond(status(429), status(429), status(429));
      const result = await askJev(
        config,
        {
          state: "x",
          id: "billing",
          question: { type: "noul", instructions: "?" },
          answer: NoulAnswer,
        },
        { ...timing, backoffInitialMs },
      );
      expect(result).toMatchObject({ ok: false, attempts: JEV_ATTEMPT_LIMIT });
      expect(waits).toEqual([backoffInitialMs, JEV_MAX_RETRY_DELAY_MS]);
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

    const longWaits: Record<string, string>[] = [
      { "retry-after": "120" },
      { "retry-after": "86400000000" },
      { "retry-after-ms": "600000" },
    ];
    for (const headers of longWaits) {
      it(`stops after 1 attempt when ${JSON.stringify(headers)} asks for a longer wait than it allows`, async () => {
        fixture.respond(status(429, headers));
        expect(await ask()).toEqual({
          ok: false,
          failure: "transient",
          reason: "status",
          status: 429,
          attempts: 1,
        });
        expect(fixture.requests).toHaveLength(1);
      });
    }

    // Only a whole number of seconds is read. A date, read as one, would ask for an hour and stop
    // the question, and `1.5`, read as seconds, would wait 1.5 seconds. As above, the wait is
    // read from the client's timer rather than timed.
    const ignoredRetryAfter = [
      new Date(Date.now() + 60 * 60 * 1000).toUTCString(),
      "-5",
      "abc",
      "1.5",
      "0",
    ];
    for (const value of ignoredRetryAfter) {
      it(`falls back to the backoff for Retry-After: ${value}`, async () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        const waits = recordClientWaits();
        fixture.respond(
          () => HttpResponse.json({}, { status: 429, headers: { "retry-after": value } }),
          () => HttpResponse.json(noulResponse),
        );
        expect(await ask()).toMatchObject({ ok: true, attempts: 2 });
        // The backoff itself, so a client that waits what the server asked, even 0 ms, fails.
        expect(waits).toEqual([timing.backoffInitialMs * 0.7525]);
      });
    }
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

    it("times out a 200 whose body stops after the headers, on each of the 3 attempts", async () => {
      // The body sends its start and then nothing until well after the time limit. It ends then,
      // short of its declared length. Without the length, the end would complete the message
      // that the client had already aborted, and MSW 3.0.3's socket emulation would make undici
      // raise an unhandled AssertionError.
      const stalled = () =>
        new HttpResponse(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode('{"model":"jev-1.13.0",'));
              await delay(timing.attemptTimeoutMs * 3);
              try {
                controller.close();
              } catch {
                // The client cancelled the body when its time ran out.
              }
            },
          }),
          { headers: { "content-type": "application/json", "content-length": "100" } },
        );
      fixture.respond(stalled, stalled, stalled);
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

    // The harness and local development leave a required secret they can't find unbound, so the
    // value can be missing although `Env` says `string`.
    it.each([
      ["an empty string", ""],
      ["only whitespace", " "],
      ["a missing value", undefined as unknown as string],
    ])("refuses %s as the key, with a code that names it, before any request", async (_, key) => {
      const error = await askJev(
        { ...config, TYPESAFE_API_KEY: key },
        {
          state: "x",
          id: "billing",
          question: { type: "noul", instructions: "?" },
          answer: NoulAnswer,
        },
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        message: "TYPESAFE_API_KEY is empty",
        code: "TYPESAFE_API_KEY_EMPTY",
      });
      expect(fixture.requests).toEqual([]);
    });

    it("is sent only over https, or http on a loopback host", async () => {
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
      ).rejects.toThrow(
        "JEV_BASE_URL must be an https URL, or an http URL on a loopback host for tests",
      );
      expect(fixture.requests).toEqual([]);
    });

    // The enrichment module runs the same checks before it sends anything for a bookmark (#126).
    it("is checked by assertJevConfig as askJev checks it, without a request", () => {
      expect(() => assertJevConfig({ ...config, TYPESAFE_API_KEY: "" })).toThrow(
        expect.objectContaining({ code: "TYPESAFE_API_KEY_EMPTY" }),
      );
      expect(() => assertJevConfig({ ...config, JEV_BASE_URL: "http://jev.test" })).toThrow(
        "JEV_BASE_URL must be an https URL, or an http URL on a loopback host for tests",
      );
      expect(() => assertJevConfig(config)).not.toThrow();
      expect(() => assertJevConfig({ ...config, JEV_BASE_URL: JEV_LOOPBACK_ORIGIN })).not.toThrow();
      expect(fixture.requests).toEqual([]);
    });

    // The integration tests' fixture server is plain http on 127.0.0.1 (Q10 in the plan), so the
    // enrichment module's tests through the Worker can reach it (#126).
    it("is sent over http to a loopback host, as an integration test's server is", async () => {
      fixture.respond(answer(noulResponse));
      const result = await askJev(
        { ...config, JEV_BASE_URL: JEV_LOOPBACK_ORIGIN },
        {
          state: "x",
          id: "billing",
          question: { type: "noul", instructions: "?" },
          answer: NoulAnswer,
        },
        timing,
      );
      expect(result).toMatchObject({ ok: true, answer: 0.98, attempts: 1 });
      expect(fixture.requests.map(({ url }) => url)).toEqual([
        `${JEV_LOOPBACK_ORIGIN}/v1/systemone`,
      ]);
      expect(fixture.requests[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    });
  });
});
