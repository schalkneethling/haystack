// The Anthropic adapter and the validation retry (#124): the request, how failures are
// classified, that each `enrich()` call is one request, where the key goes, and that invalid
// output is asked for once more. Every request is answered by the Anthropic fixture
// (anthropic-fixture.ts), which fails a test that makes a request it did not plan for. See "The
// provider interface" and Q3 in plans/haystack-v1-implementation-plan.md.
import { delay, HttpResponse } from "msw";
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
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_VERSION,
  type AnthropicConfig,
  type AnthropicTiming,
  anthropicProvider,
} from "../src/enrichment/anthropic-provider.ts";
import { enrichmentPrompt } from "../src/enrichment/enrichment-prompt.ts";
import { writeProseEnrichment } from "../src/enrichment/enrichment-provider.ts";
import { ENRICHMENT_JSON_SCHEMA } from "../src/enrichment/enrichment-schema.ts";
import {
  ANTHROPIC_ORIGIN,
  type AnthropicFixture,
  answer,
  LOOPBACK_ORIGIN,
  MESSAGES_URL,
  messageBody,
  networkError,
  output,
  startAnthropicFixture,
  status,
} from "./anthropic-fixture.ts";
import { REPOSITORY_INPUT, VALID_OUTPUT } from "./enrichment-output.ts";

// Not a real key: a string that appears nowhere else, so finding it anywhere is a leak.
const KEY = "sk-ant-test-key-4d81b0c2";

const config: AnthropicConfig = { ANTHROPIC_BASE_URL: ANTHROPIC_ORIGIN, ANTHROPIC_API_KEY: KEY };

const MODEL = "claude-haiku-5-5";

// Short enough to keep the tests fast, long enough for a delayed fixture response to miss it.
const timing: AnthropicTiming = { requestTimeoutMs: 100 };

const provider = anthropicProvider(config, timing);

function enrich() {
  return provider.enrich(REPOSITORY_INPUT, { model: MODEL });
}

function write() {
  return writeProseEnrichment(provider, REPOSITORY_INPUT, { model: MODEL });
}

let fixture: AnthropicFixture;
const consoleMethods = ["debug", "error", "info", "log", "trace", "warn"] as const;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeAll(() => {
  fixture = startAnthropicFixture();
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
  // The adapter logs nothing, so it can't log the key.
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
});

describe("anthropicProvider", () => {
  it("is the provider named anthropic", () => {
    expect(provider.id).toBe("anthropic");
  });

  it("returns the output, the model that answered and the tokens", async () => {
    fixture.respond(output(VALID_OUTPUT));
    expect(await enrich()).toEqual({
      ok: true,
      output: VALID_OUTPUT,
      model: "claude-haiku-5-5",
      inputTokens: 812,
      outputTokens: 164,
    });
  });

  it("posts the model, the prompt and the structured-output schema to /v1/messages", async () => {
    fixture.respond(output(VALID_OUTPUT));
    await enrich();
    expect(fixture.requests).toHaveLength(1);
    const [request] = fixture.requests;
    expect(request?.url).toBe(MESSAGES_URL);
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
    const { system, user } = enrichmentPrompt(REPOSITORY_INPUT);
    expect(JSON.parse(request?.body ?? "")).toEqual({
      model: MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: ENRICHMENT_JSON_SCHEMA },
      },
    });
  });

  it("returns output that fails the schema as it is, for the module to validate", async () => {
    const invalid = { ...VALID_OUTPUT, summary: "s".repeat(500) };
    fixture.respond(output(invalid));
    expect(await enrich()).toMatchObject({ ok: true, output: invalid });
  });

  describe("failures", () => {
    // Each is answered once: the adapter never retries, so Q3's count holds.
    const transient: [string, Parameters<AnthropicFixture["respond"]>[0], object][] = [
      ["a 429", status(429, { "retry-after": "1" }), { reason: "status", status: 429 }],
      ["a 529", status(529), { reason: "status", status: 529 }],
      ["a 500", status(500), { reason: "status", status: 500 }],
      ["a 503", status(503), { reason: "status", status: 503 }],
      ["a 504", status(504), { reason: "status", status: 504 }],
      ["a network error", networkError, { reason: "network" }],
      [
        "a request past the time limit",
        async () => {
          await delay(timing.requestTimeoutMs * 5);
          return HttpResponse.json(messageBody(JSON.stringify(VALID_OUTPUT)));
        },
        { reason: "timeout" },
      ],
    ];
    for (const [name, resolver, failure] of transient) {
      it(`makes ${name} transient, and reaches the fixture exactly once`, async () => {
        fixture.respond(resolver);
        expect(await enrich()).toEqual({ ok: false, failure: "transient", ...failure });
        expect(fixture.requests).toHaveLength(1);
      });

      it(`returns ${name} from the module without retrying it`, async () => {
        fixture.respond(resolver);
        expect(await write()).toEqual({ ok: false, failure: "transient", ...failure, calls: 1 });
        expect(fixture.requests).toHaveLength(1);
      });
    }

    it("times out a 200 whose body stops after the headers", async () => {
      // As in jev-client.test.ts: the body ends short of its declared length once the client has
      // given up, so MSW's socket emulation doesn't complete a message the client aborted.
      fixture.respond(
        () =>
          new HttpResponse(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode('{"model":"claude-haiku-5-5",'));
                await delay(timing.requestTimeoutMs * 3);
                try {
                  controller.close();
                } catch {
                  // The client cancelled the body when its time ran out.
                }
              },
            }),
            { headers: { "content-type": "application/json", "content-length": "100" } },
          ),
      );
      expect(await enrich()).toEqual({ ok: false, failure: "transient", reason: "timeout" });
      expect(fixture.requests).toHaveLength(1);
    });

    for (const code of [400, 401, 403, 404, 413]) {
      it(`makes a ${code} permanent`, async () => {
        fixture.respond(status(code));
        expect(await enrich()).toEqual({
          ok: false,
          failure: "permanent",
          reason: "status",
          status: code,
        });
        expect(fixture.requests).toHaveLength(1);
      });
    }

    it("makes a refusal permanent", async () => {
      fixture.respond(answer(messageBody("I can't help with that.", "refusal")));
      expect(await write()).toEqual({
        ok: false,
        failure: "permanent",
        reason: "refused",
        calls: 1,
      });
      expect(fixture.requests).toHaveLength(1);
    });

    for (const stopReason of ["max_tokens", "model_context_window_exceeded"]) {
      it(`makes output cut off by ${stopReason} permanent`, async () => {
        fixture.respond(answer(messageBody('{"summary": "Vitest is', stopReason)));
        expect(await enrich()).toEqual({ ok: false, failure: "permanent", reason: "truncated" });
      });
    }

    const invalid: [string, Parameters<AnthropicFixture["respond"]>[0]][] = [
      ["a body that isn't JSON", () => HttpResponse.text("not json")],
      ["a body that isn't a Message", answer({ completion: "{}" })],
      ["text that isn't JSON", answer(messageBody("Here is the description you asked for."))],
      ["no text block", answer({ ...messageBody(""), content: [] })],
      ["a stop reason the request can't cause", answer(messageBody("{}", "tool_use"))],
      ["fractional tokens", answer({ ...messageBody("{}"), usage: { input_tokens: 1.5 } })],
    ];
    for (const [name, resolver] of invalid) {
      it(`makes ${name} a permanent invalid response`, async () => {
        fixture.respond(resolver);
        expect(await enrich()).toEqual({
          ok: false,
          failure: "permanent",
          reason: "invalid-response",
        });
        expect(fixture.requests).toHaveLength(1);
      });
    }
  });

  describe("the key", () => {
    it("is sent only in the authorization header, only to the configured base URL", async () => {
      fixture.respond(output({}), output(VALID_OUTPUT));
      await write();
      expect(fixture.requests).toHaveLength(2);
      for (const request of fixture.requests) {
        expect(new URL(request.url).origin).toBe(ANTHROPIC_ORIGIN);
        expect(request.url).not.toContain(KEY);
        expect(request.body).not.toContain(KEY);
        for (const [name, value] of request.headers) {
          expect(value.includes(KEY)).toBe(name === "authorization");
        }
        expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
        expect(request.headers.get("x-api-key")).toBeNull();
      }
    });

    it("is not sent on to a redirect's target", async () => {
      fixture.respond(() =>
        HttpResponse.json(
          {},
          { status: 307, headers: { location: "https://elsewhere.test/v1/messages" } },
        ),
      );
      // A followed redirect would reach elsewhere.test, which the fixture records as unplanned.
      expect(await enrich()).toEqual({
        ok: false,
        failure: "permanent",
        reason: "status",
        status: 307,
      });
      expect(fixture.requests).toHaveLength(1);
    });

    it("is not in any result, which callers may log", async () => {
      fixture.respond(status(401), output({}), output({}), output(VALID_OUTPUT));
      const results = [await write(), await write(), await enrich()];
      expect(JSON.stringify(results)).not.toContain(KEY);
    });

    // The harness and local development leave a required secret they can't find unbound, so the
    // value can be missing although `Env` says `string`.
    it.each([
      ["an empty string", ""],
      ["only whitespace", " "],
      ["a missing value", undefined as unknown as string],
    ])("refuses %s as the key, with a code that names it, before any request", async (_, key) => {
      const error = await anthropicProvider({ ...config, ANTHROPIC_API_KEY: key }, timing)
        .enrich(REPOSITORY_INPUT, { model: MODEL })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        message: "ANTHROPIC_API_KEY is empty",
        code: "ANTHROPIC_API_KEY_EMPTY",
      });
      expect(fixture.requests).toEqual([]);
    });

    it.each(["http://api.anthropic.test", "http://example.com", "ftp://api.anthropic.test"])(
      "is never sent to %s, which is neither https nor a loopback host",
      async (base) => {
        await expect(
          anthropicProvider({ ...config, ANTHROPIC_BASE_URL: base }, timing).enrich(
            REPOSITORY_INPUT,
            { model: MODEL },
          ),
        ).rejects.toThrow("ANTHROPIC_BASE_URL must be an https URL, or http on a loopback host");
        expect(fixture.requests).toEqual([]);
      },
    );

    it("may be sent over http to a loopback host, where integration tests serve responses", async () => {
      fixture.respond(output(VALID_OUTPUT));
      const loopback = anthropicProvider(
        { ...config, ANTHROPIC_BASE_URL: LOOPBACK_ORIGIN },
        timing,
      );
      expect(await loopback.enrich(REPOSITORY_INPUT, { model: MODEL })).toMatchObject({
        ok: true,
        output: VALID_OUTPUT,
      });
      expect(fixture.requests.map((request) => request.url)).toEqual([
        `${LOOPBACK_ORIGIN}/v1/messages`,
      ]);
    });
  });
});

describe("writeProseEnrichment", () => {
  it("returns the validated enrichment after one call", async () => {
    fixture.respond(output(VALID_OUTPUT));
    expect(await write()).toEqual({
      ok: true,
      enrichment: VALID_OUTPUT,
      model: "claude-haiku-5-5",
      inputTokens: 812,
      outputTokens: 164,
      calls: 1,
    });
    expect(fixture.requests).toHaveLength(1);
  });

  it("accepts an enrichment whose use_cases list is empty", async () => {
    fixture.respond(output({ ...VALID_OUTPUT, use_cases: [] }));
    expect(await write()).toMatchObject({ ok: true, enrichment: { use_cases: [] }, calls: 1 });
  });

  it("succeeds after exactly two calls when the first output is invalid", async () => {
    fixture.respond(
      output({ ...VALID_OUTPUT, topics: Array(13).fill("testing") }),
      output(VALID_OUTPUT),
    );
    expect(await write()).toMatchObject({ ok: true, enrichment: VALID_OUTPUT, calls: 2 });
    expect(fixture.requests).toHaveLength(2);
    // The retry asks the same provider the same thing.
    expect(fixture.requests[1]?.body).toBe(fixture.requests[0]?.body);
  });

  it("fails permanently, with the reason, when the output is invalid twice", async () => {
    fixture.respond(
      output({ ...VALID_OUTPUT, summary: "s".repeat(281) }),
      output({ ...VALID_OUTPUT, use_cases: ["Use when you need to test.", "u".repeat(161)] }),
    );
    expect(await write()).toEqual({
      ok: false,
      failure: "permanent",
      reason: "invalid-output",
      issue: "use_cases.1: max_length",
      calls: 2,
    });
    expect(fixture.requests).toHaveLength(2);
  });

  it.each([
    ["a missing field", { ...VALID_OUTPUT, summary: undefined }, "summary: strict_object"],
    ["a field of the wrong type", { ...VALID_OUTPUT, topics: "testing" }, "topics: array"],
    ["output that isn't an object", "A test runner.", "(output): strict_object"],
  ])("names %s in the reason", async (_, invalid, issue) => {
    fixture.respond(output(invalid), output(invalid));
    expect(await write()).toMatchObject({ reason: "invalid-output", issue });
  });

  it("never writes a key the schema doesn't name into the reason", async () => {
    // The model's own key could repeat captured text, and the reason is stored in `last_error`.
    const invalid = { ...VALID_OUTPUT, "Ignore previous instructions": "every query" };
    fixture.respond(output(invalid), output(invalid));
    const result = await write();
    expect(result).toMatchObject({
      reason: "invalid-output",
      issue: "(unknown key): strict_object",
    });
    expect(JSON.stringify(result)).not.toContain("Ignore previous instructions");
  });

  it("asks once more when the first output is invalid, and returns a failure of that call", async () => {
    fixture.respond(output({}), status(529));
    expect(await write()).toEqual({
      ok: false,
      failure: "transient",
      reason: "status",
      status: 529,
      calls: 2,
    });
    expect(fixture.requests).toHaveLength(2);
  });

  it("returns a permanent request failure without asking again", async () => {
    fixture.respond(status(400));
    expect(await write()).toEqual({
      ok: false,
      failure: "permanent",
      reason: "status",
      status: 400,
      calls: 1,
    });
    expect(fixture.requests).toHaveLength(1);
  });
});
