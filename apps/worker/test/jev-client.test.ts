// The Jev client (#122): retries, how failures are classified, and where the key goes. Every
// request is answered by the Jev fixture (jev-fixture.ts), which fails a test that makes a
// request it did not plan for. See "Jev client" and Q3 in plans/haystack-v1-implementation-plan.md.
import type { UnderlyingDefaultSource } from "node:stream/web";
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
import {
  askJev,
  askJevQuestions,
  assertJevConfig,
  JEV_ATTEMPT_LIMIT,
  JEV_MAX_RETRY_DELAY_MS,
  type JevConfig,
  type JevQuestions,
  type JevRequestGate,
  type JevResult,
  type JevTiming,
  NoulAnswer,
  scoreAnswer,
} from "../src/enrichment/jev-client.ts";
import {
  answer,
  JEV_LOOPBACK_ORIGIN,
  JEV_ORIGIN,
  type JevFixture,
  type JevResolver,
  networkError,
  startJevFixture,
  status,
  SYSTEM_ONE_URL,
} from "./jev-fixture.ts";

// Not a real key: a string that appears nowhere else, so finding it anywhere is a leak.
const KEY = "ts-test-key-7f3a9c1e";

const config: JevConfig = {
  JEV_BASE_URL: JEV_ORIGIN,
  JEV_MODEL: "jev-1.14.0",
  TYPESAFE_API_KEY: KEY,
};

// Short enough to keep the tests fast, long enough for a delayed fixture response to miss it.
const timing: JevTiming = { attemptTimeoutMs: 100, backoffInitialMs: 1 };

// The API reference's Noul response example (https://docs.typesafe.ai/api/system-one.md, read
// on 2026-10-28), with the pinned model in place of the alias the example names, because a
// response names the model that answered.
const noulResponse = {
  model: "jev-1.14.0",
  answers: { billing: { type: "noul", noul: 0.98 } },
  usage: { input_tokens: 120, output_tokens: 12 },
};

function ask(signal?: AbortSignal): Promise<JevResult<number>> {
  return askJev(
    config,
    {
      state: "I was charged twice for my subscription this month.",
      id: "billing",
      question: { type: "noul", instructions: "Is this message about billing?" },
      answer: NoulAnswer,
    },
    timing,
    signal,
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
      model: "jev-1.14.0",
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
      model: "jev-1.14.0",
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

    // A sweep run that has stopped sends nothing more (#127).
    it("sends nothing, and throws the signal's reason, when its signal is already aborted", async () => {
      const run = new AbortController();
      const stopped = new Error("The run stopped");
      run.abort(stopped);
      await expect(ask(run.signal)).rejects.toBe(stopped);
      expect(fixture.requests).toEqual([]);
    });

    // A sweep run that has stopped wants no more paid attempts (#127).
    it("makes no other attempt once its signal is aborted, nor waits, and returns the last failure", async () => {
      const run = new AbortController();
      const waits = recordClientWaits();
      fixture.respond((request) => {
        run.abort(new Error("The run stopped"));
        return status(503)(request);
      });
      expect(await ask(run.signal)).toEqual({
        ok: false,
        failure: "transient",
        reason: "status",
        status: 503,
        attempts: 1,
      });
      expect(fixture.requests).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    // The run stops once the client has started its backoff, which is the longest the client
    // allows, and the client must stop waiting at once: its timer never fires.
    it("stops waiting out its backoff when its signal is aborted", async () => {
      const run = new AbortController();
      const setTimeoutAsGiven = globalThis.setTimeout;
      let backoffStarted = false;
      let backoffFired = false;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(
        (...args: Parameters<typeof setTimeout>) => {
          const stackTraceLimit = Error.stackTraceLimit;
          Error.stackTraceLimit = 50;
          const stack = new Error().stack ?? "";
          Error.stackTraceLimit = stackTraceLimit;
          if (!/\bsleep \([^)]*src[\\/]enrichment[\\/]jev-client\.ts/.test(stack)) {
            return setTimeoutAsGiven(...args);
          }
          backoffStarted = true;
          // After the client's wait has begun listening for the signal.
          queueMicrotask(() => run.abort(new Error("The run stopped")));
          const [callback, milliseconds] = args;
          return setTimeoutAsGiven(() => {
            backoffFired = true;
            callback();
          }, milliseconds);
        },
      );
      fixture.respond(status(503));
      const longest: JevTiming = { ...timing, backoffInitialMs: 60_000 };
      const result = await askJev(
        config,
        {
          state: "x",
          id: "billing",
          question: { type: "noul", instructions: "?" },
          answer: NoulAnswer,
        },
        longest,
        run.signal,
      );
      expect(result).toMatchObject({ ok: false, status: 503, attempts: 1 });
      expect(backoffStarted).toBe(true);
      expect(backoffFired).toBe(false);
      expect(fixture.requests).toHaveLength(1);
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

    // The errors page's 401 is "Missing or invalid API key", which is Haystack's account, not the
    // question. It documents no 402 or 403, which keep their HTTP meaning (#127).
    for (const code of [401, 402, 403]) {
      it(`makes a ${code} the account's failure, without retrying it`, async () => {
        fixture.respond(status(code));
        expect(await ask()).toEqual({
          ok: false,
          failure: "account",
          reason: "status",
          status: code,
          attempts: 1,
        });
        expect(fixture.requests).toHaveLength(1);
      });
    }

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

    // The save form's check makes one attempt (#132). A larger limit is capped, because Q3
    // counts JEV_ATTEMPT_LIMIT requests per question.
    it.each([
      [1, 1],
      [2, 2],
      [JEV_ATTEMPT_LIMIT + 2, JEV_ATTEMPT_LIMIT],
    ])("with an attempt limit of %i, makes %i requests", async (attemptLimit, expected) => {
      fixture.respond(...Array.from({ length: expected }, () => networkError));
      const result = await askJev(
        config,
        {
          state: "I was charged twice for my subscription this month.",
          id: "billing",
          question: { type: "noul", instructions: "Is this message about billing?" },
          answer: NoulAnswer,
        },
        { ...timing, attemptLimit },
      );
      expect(result).toEqual({
        ok: false,
        failure: "transient",
        reason: "network",
        attempts: expected,
      });
      expect(fixture.requests).toHaveLength(expected);
    });

    // A limit that isn't a whole number from 1 would otherwise make one attempt, or, for NaN,
    // retry for good, so it is the caller's bug, and nothing is sent.
    it.each([0, -1, 0.5, Number.NaN])(
      "throws for an attempt limit of %s, before anything is sent",
      async (attemptLimit) => {
        await expect(
          askJev(
            config,
            {
              state: "I was charged twice for my subscription this month.",
              id: "billing",
              question: { type: "noul", instructions: "Is this message about billing?" },
              answer: NoulAnswer,
            },
            { ...timing, attemptLimit },
          ),
        ).rejects.toThrow(RangeError);
        expect(fixture.requests).toEqual([]);
      },
    );

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
              controller.enqueue(new TextEncoder().encode('{"model":"jev-1.14.0",'));
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
      ).rejects.toMatchObject({
        message: "JEV_BASE_URL must be an https URL, or http on a loopback host",
        code: "JEV_BASE_URL_INVALID",
      });
      expect(fixture.requests).toEqual([]);
    });

    // `new URL` would throw a bare TypeError for each of these, with no code (#155).
    it.each([
      ["an empty string", ""],
      ["a missing value", undefined as unknown as string],
      ["a value that isn't a URL", "api.typesafe.ai"],
    ])(
      "refuses %s as the base URL, with a code that names it, before any request",
      async (_, base) => {
        expect(() => assertJevConfig({ ...config, JEV_BASE_URL: base })).toThrow(
          expect.objectContaining({
            message: "JEV_BASE_URL is empty or isn't a URL",
            code: "JEV_BASE_URL_INVALID",
          }),
        );
        await expect(
          askJev(
            { ...config, JEV_BASE_URL: base },
            {
              state: "x",
              id: "billing",
              question: { type: "noul", instructions: "?" },
              answer: NoulAnswer,
            },
          ),
        ).rejects.toMatchObject({ code: "JEV_BASE_URL_INVALID" });
        expect(fixture.requests).toEqual([]);
      },
    );

    // The enrichment module runs the same checks before it sends anything for a bookmark (#126).
    it("is checked by assertJevConfig as askJev checks it, without a request", () => {
      expect(() => assertJevConfig({ ...config, TYPESAFE_API_KEY: "" })).toThrow(
        expect.objectContaining({ code: "TYPESAFE_API_KEY_EMPTY" }),
      );
      expect(() => assertJevConfig({ ...config, JEV_BASE_URL: "http://jev.test" })).toThrow(
        expect.objectContaining({ code: "JEV_BASE_URL_INVALID" }),
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

// The gate is how search's limiter (search/jev-limiter.ts, #211) holds every attempt of a request,
// retries included, under its ceilings, and learns of a `429`.
describe("askJevQuestions with a gate", () => {
  const question: JevQuestions = {
    billing: { type: "noul", instructions: "Is this message about billing?" },
  };
  const read = (answers: Readonly<Record<string, unknown>>) => {
    const parsed = v.safeParse(NoulAnswer, answers.billing);
    return parsed.success ? parsed.output : undefined;
  };

  // A gate that records each call among the requests the fixture receives, in order.
  function recordingGate(events: string[], onWait?: (count: number) => void): JevRequestGate {
    let waits = 0;
    return {
      wait: async () => {
        waits += 1;
        events.push("wait");
        onWait?.(waits);
      },
      throttled: (retryAfterMs) => {
        events.push(`throttled ${String(retryAfterMs)}`);
      },
    };
  }

  function sent(events: string[], resolver: JevResolver): JevResolver {
    return (request) => {
      events.push("sent");
      return resolver(request);
    };
  }

  function askWith(gate: JevRequestGate, signal?: AbortSignal) {
    return askJevQuestions(config, "I was charged twice.", question, read, timing, signal, gate);
  }

  it("waits on the gate before every attempt, retries included", async () => {
    const events: string[] = [];
    fixture.respond(sent(events, status(503)), sent(events, answer(noulResponse)));
    expect(await askWith(recordingGate(events))).toMatchObject({ ok: true, attempts: 2 });
    expect(events).toEqual(["wait", "sent", "wait", "sent"]);
  });

  it("tells the gate of each 429 and the wait it asked for, and of no other status", async () => {
    const events: string[] = [];
    fixture.respond(
      sent(events, status(429, { "retry-after-ms": "5" })),
      sent(events, status(529)),
      sent(events, status(429)),
    );
    expect(await askWith(recordingGate(events))).toMatchObject({ ok: false, status: 429 });
    expect(events).toEqual([
      "wait",
      "sent",
      "throttled 5",
      "wait",
      "sent",
      "wait",
      "sent",
      "throttled undefined",
    ]);
  });

  it("sends nothing, and throws the signal's reason, when the first wait is aborted", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const gate = recordingGate(events, () => {
      controller.abort(new Error("stopped"));
    });
    await expect(askWith(gate, controller.signal)).rejects.toThrow("stopped");
    expect(fixture.requests).toEqual([]);
  });

  it("returns the last failure, and sends nothing more, when a later wait is aborted", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const gate = recordingGate(events, (count) => {
      if (count === 2) {
        controller.abort();
      }
    });
    fixture.respond(sent(events, status(503)));
    expect(await askWith(gate, controller.signal)).toEqual({
      ok: false,
      failure: "transient",
      reason: "status",
      status: 503,
      attempts: 1,
    });
    expect(events).toEqual(["wait", "sent", "wait"]);
  });
});

// Request rules and errors (https://docs.typesafe.ai/api/errors.md, read on 2026-11-04) says a
// `400` "With `max_tokens_exceeded`" is a request longer than the model's context length, and the
// API reference gives a `400`'s `detail` as a string or an object, without saying where the code
// goes. So the code is read wherever `detail` names it, and these are both shapes.
describe("a 400's error code", () => {
  const tooLong: [string, JsonBodyType][] = [
    ["a string detail", { detail: "max_tokens_exceeded: the request is 70,412 tokens" }],
    ["an object detail", { detail: { code: "max_tokens_exceeded", message: "Too long" } }],
  ];
  it.each(tooLong)("is max_tokens_exceeded when %s names it", async (_, body) => {
    fixture.respond(() => HttpResponse.json(body, { status: 400 }));
    expect(await ask()).toEqual({
      ok: false,
      failure: "permanent",
      reason: "status",
      status: 400,
      code: "max_tokens_exceeded",
      attempts: 1,
    });
  });

  // The body is read only for the code, so a body that breaks or stops arriving changes nothing:
  // the 400 is permanent, as it was before the client read it, and isn't retried.
  const permanent400 = {
    ok: false,
    failure: "permanent",
    reason: "status",
    status: 400,
    attempts: 1,
  };

  // MSW's mocked connection can't carry a body that breaks or stops arriving: it fails the whole
  // `fetch` before the headers arrive, or closes the socket of an aborted request, which undici
  // refuses. So these two tests replace `fetch` itself with a 400 whose body breaks after its
  // first bytes, or stops arriving and errors when the request's signal aborts, as a real body
  // does when the attempt's time limit passes.
  it.each([
    [
      "breaks",
      (): UnderlyingDefaultSource<Uint8Array> => ({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"detail":'));
        },
        pull(controller) {
          controller.error(new Error("The connection broke"));
        },
      }),
    ],
    [
      "stops arriving",
      (signal: AbortSignal | null | undefined): UnderlyingDefaultSource<Uint8Array> => ({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"detail":"max_tokens_'));
          signal?.addEventListener("abort", () => {
            controller.error(signal.reason);
          });
        },
      }),
    ],
  ])("is absent, and the 400 stays permanent, when the body %s", async (_, source) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (_input, init) =>
          new Response(new ReadableStream(source(init?.signal)), { status: 400 }),
      );
    expect(await ask()).toEqual(permanent400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // A 413 is only a body over 32 MiB, so it is never "too large" for the chunker, whatever its
  // body says. A 400 for another rule has no code that a caller acts on.
  it.each([
    ["a 413 whose body names the code", 413, { detail: "max_tokens_exceeded" }],
    ["a 400 for another rule", 400, { detail: "invalid UTF-8" }],
    ["a 400 whose code is only part of a word", 400, { detail: "not_max_tokens_exceeded_here" }],
    ["a 400 whose body isn't JSON", 400, "max_tokens_exceeded"],
  ] as const)("is absent for %s", async (_, code, body) => {
    fixture.respond(() =>
      typeof body === "string"
        ? HttpResponse.text(body, { status: code })
        : HttpResponse.json(body, { status: code }),
    );
    expect(await ask()).toEqual({
      ok: false,
      failure: "permanent",
      reason: "status",
      status: code,
      attempts: 1,
    });
  });
});

// Search's answers are validated with it (jev-search.test.ts, #210).
describe("scoreAnswer", () => {
  // The API accepts from 1 to 10 levels, so any other count is a bug in the caller.
  it.each([0, 11, 2.5, Number.NaN])("throws for %s levels", (levelCount) => {
    expect(() => scoreAnswer(levelCount)).toThrow(RangeError);
  });

  it("reads the API reference's Score example, over its three levels", () => {
    // The example in https://docs.typesafe.ai/api/system-one.md, read on 2026-11-01.
    const example = {
      type: "score",
      score: 1.7,
      confidence: 0.55,
      legend: { "0": "Can wait", "1": "Needs attention this week", "2": "Needs attention today" },
      probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
    };
    expect(v.parse(scoreAnswer(3), example)).toEqual({
      score: 1.7,
      probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
      confidence: 0.55,
    });
  });

  // The Score page's recorded jev-1.13.0 answer to its bug-severity question
  // (https://docs.typesafe.ai/primitives/score.md, "Response structure", read on 2026-11-01).
  it("keeps the Score page's recorded answer as returned", () => {
    const recorded = {
      type: "score",
      score: 1.43,
      confidence: 0.35,
      legend: {
        "0": "Cosmetic; no impact to functionality",
        "1": "Broken or degraded feature, but workaround exists",
        "2": "Blocking issue; no workaround exists",
      },
      probabilities: { "0": 0.0, "1": 0.57, "2": 0.43 },
    };
    const kept = v.parse(scoreAnswer(3), recorded);
    expect(kept).toEqual({
      score: 1.43,
      probabilities: { "0": 0.0, "1": 0.57, "2": 0.43 },
      confidence: 0.35,
    });
    // The score is the weighted mean of the level numbers, 0 × 0.0 + 1 × 0.57 + 2 × 0.43. That is
    // a property of the API's answer, not of Haystack's code, which derives no number and keeps the
    // score as Jev sent it.
    const weightedMean = Object.entries(recorded.probabilities).reduce(
      (sum, [level, probability]) => sum + Number(level) * probability,
      0,
    );
    expect(kept.score).toBeCloseTo(weightedMean, 10);
  });

  // Over four levels, as search asks, with the plan's worked example: 0.1, 0.1, 0.2 and 0.6.
  const fourLevels = scoreAnswer(4);
  const answer = (score: number, probabilities: Record<string, number>) => ({
    type: "score",
    score,
    confidence: 0.41,
    legend: { "0": "a", "1": "b", "2": "c", "3": "d" },
    probabilities,
  });
  const worked = { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.6 };

  // A weighted mean computed in floating point can land a hair above the top level.
  it("accepts a score a rounding error above the top level, and no further", () => {
    const top = { "0": 0, "1": 0, "2": 0, "3": 1 };
    expect(v.safeParse(fourLevels, answer(3.0000000000000004, top)).success).toBe(true);
    expect(v.safeParse(fourLevels, answer(3.001, top)).success).toBe(false);
  });

  // Two-decimal probabilities can add up to as little as 0.98 or as much as 1.02 over four
  // levels, which is a distribution. Further off is not.
  it.each([
    ["0.98", { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.58 }],
    ["1.02", { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.62 }],
    ["1", worked],
  ])("accepts probabilities that add up to %s", (_, probabilities) => {
    expect(v.safeParse(fourLevels, answer(2.3, probabilities)).success).toBe(true);
  });

  it.each([
    ["0", { "0": 0, "1": 0, "2": 0, "3": 0 }],
    ["0.97", { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.57 }],
    ["1.03", { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.63 }],
  ])("refuses probabilities that add up to %s", (_, probabilities) => {
    expect(v.safeParse(fourLevels, answer(0, probabilities)).success).toBe(false);
  });
});
