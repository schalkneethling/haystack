// The LLM provider adapters and the validation retry (#124, #125). One contract suite runs
// against both the Anthropic adapter and the AI Gateway adapter: the request, how failures are
// classified, that each `enrich()` call is one request, where the Anthropic key goes, and that
// invalid output is asked for once more. The tests that only one adapter has come after it.
// Every request is answered by the Anthropic fixture (anthropic-fixture.ts), which serves both
// endpoints and fails a test that makes a request it did not plan for, or sends the gateway a
// request whose bodies it would log. See "The provider interface", Q3 and Q7 in
// plans/haystack-v1-implementation-plan.md.
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
import { aiGatewayProvider, type AiGatewayConfig } from "../src/enrichment/ai-gateway-provider.ts";
import {
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_VERSION,
  type AnthropicTiming,
  messagesProvider,
} from "../src/enrichment/anthropic-messages.ts";
import { anthropicProvider } from "../src/enrichment/anthropic-provider.ts";
import { enrichmentPrompt } from "../src/enrichment/enrichment-prompt.ts";
import {
  type EnrichmentProvider,
  writeProseEnrichment,
} from "../src/enrichment/enrichment-provider.ts";
import { ENRICHMENT_JSON_SCHEMA } from "../src/enrichment/enrichment-schema.ts";
import {
  ANTHROPIC_ORIGIN,
  type AnthropicFixture,
  type AnthropicResolver,
  answer,
  GATEWAY_ACCOUNT_ID,
  GATEWAY_ID,
  GATEWAY_MESSAGES_URL,
  GATEWAY_ORIGIN,
  GATEWAY_PATH,
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

// Not a real gateway token either, and not the key, so each can be told apart.
const TOKEN = "cf-aig-test-token-9e17a6d3";

const gatewayConfig: AiGatewayConfig = {
  AI_GATEWAY_BASE_URL: GATEWAY_ORIGIN,
  AI_GATEWAY_ACCOUNT_ID: GATEWAY_ACCOUNT_ID,
  AI_GATEWAY_ID: GATEWAY_ID,
  AI_GATEWAY_TOKEN: TOKEN,
  ANTHROPIC_API_KEY: KEY,
};

const MODEL = "claude-haiku-5-5";

// Short enough to keep the tests fast, long enough for a delayed fixture response to miss it.
const timing: AnthropicTiming = { requestTimeoutMs: 100 };

/** An adapter under the contract, with the tests' configuration. */
interface Adapter {
  readonly name: string;
  readonly provider: EnrichmentProvider;
  // The same adapter with a different Anthropic key, or a different base URL.
  withKey(key: string): EnrichmentProvider;
  withBaseUrl(baseUrl: string): EnrichmentProvider;
  // The variable that holds the base URL, which its error names.
  readonly baseUrlName: string;
  readonly origin: string;
  // Where it posts every request, and where it posts with a loopback base URL.
  readonly url: string;
  readonly loopbackUrl: string;
  // The one header the Anthropic key goes in, its value there, and the other key header, which
  // it never sends.
  readonly keyHeader: string;
  readonly keyValue: string;
  readonly otherKeyHeader: string;
  // Every credential it sends, none of which may be in a result.
  readonly credentials: readonly string[];
}

const ADAPTERS: readonly Adapter[] = [
  {
    name: "anthropicProvider",
    provider: anthropicProvider(
      { ANTHROPIC_BASE_URL: ANTHROPIC_ORIGIN, ANTHROPIC_API_KEY: KEY },
      timing,
    ),
    withKey: (key) =>
      anthropicProvider({ ANTHROPIC_BASE_URL: ANTHROPIC_ORIGIN, ANTHROPIC_API_KEY: key }, timing),
    withBaseUrl: (baseUrl) =>
      anthropicProvider({ ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: KEY }, timing),
    baseUrlName: "ANTHROPIC_BASE_URL",
    origin: ANTHROPIC_ORIGIN,
    url: MESSAGES_URL,
    loopbackUrl: `${LOOPBACK_ORIGIN}/v1/messages`,
    keyHeader: "authorization",
    keyValue: `Bearer ${KEY}`,
    otherKeyHeader: "x-api-key",
    credentials: [KEY],
  },
  {
    name: "aiGatewayProvider",
    provider: aiGatewayProvider(gatewayConfig, timing),
    withKey: (key) => aiGatewayProvider({ ...gatewayConfig, ANTHROPIC_API_KEY: key }, timing),
    withBaseUrl: (baseUrl) =>
      aiGatewayProvider({ ...gatewayConfig, AI_GATEWAY_BASE_URL: baseUrl }, timing),
    baseUrlName: "AI_GATEWAY_BASE_URL",
    origin: GATEWAY_ORIGIN,
    url: GATEWAY_MESSAGES_URL,
    loopbackUrl: `${LOOPBACK_ORIGIN}${GATEWAY_PATH}`,
    // The gateway answered a key in `authorization` with a 400 on 2026-10-24.
    keyHeader: "x-api-key",
    keyValue: KEY,
    otherKeyHeader: "authorization",
    credentials: [KEY, TOKEN],
  },
];

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
  // No test makes a request that the fixture didn't plan for, so none reaches the network, and
  // none reaches the gateway without the header that keeps its bodies out of the log.
  expect(fixture.unplanned).toEqual([]);
  // The adapters log nothing, so they can't log a credential.
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
});

for (const adapter of ADAPTERS) {
  const { provider } = adapter;
  const enrich = () => provider.enrich(REPOSITORY_INPUT, { model: MODEL });
  const write = () => writeProseEnrichment(provider, REPOSITORY_INPUT, { model: MODEL });

  describe(`${adapter.name}, under the shared contract`, () => {
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

    it("posts the model, the prompt and the structured-output schema to its endpoint", async () => {
      fixture.respond(output(VALID_OUTPUT));
      await enrich();
      expect(fixture.requests).toHaveLength(1);
      const [request] = fixture.requests;
      expect(request?.url).toBe(adapter.url);
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
      const transient: [string, AnthropicResolver, object][] = [
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
        // As in jev-client.test.ts: the body ends short of its declared length once the client
        // has given up, so MSW's socket emulation doesn't complete a message the client aborted.
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

      // The gateway's own errors, such as a missing token, aren't documented, so they are
      // classified by their status like Anthropic's, and these cover them too.
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

      it("makes a refusal in stop_details permanent, whatever stop_reason says", async () => {
        // The shape of the Messages API reference's example: `end_turn` with refusal details.
        fixture.respond(
          answer({
            ...messageBody(JSON.stringify(VALID_OUTPUT)),
            stop_details: {
              type: "refusal",
              category: "general_harms",
              explanation: "This request was declined.",
            },
          }),
        );
        expect(await write()).toEqual({
          ok: false,
          failure: "permanent",
          reason: "refused",
          calls: 1,
        });
        expect(fixture.requests).toHaveLength(1);
      });

      it("reads an answer whose stop_details is null", async () => {
        fixture.respond(
          answer({ ...messageBody(JSON.stringify(VALID_OUTPUT)), stop_details: null }),
        );
        expect(await enrich()).toMatchObject({ ok: true, output: VALID_OUTPUT });
      });

      for (const stopReason of ["max_tokens", "model_context_window_exceeded"]) {
        it(`makes output cut off by ${stopReason} truncated`, async () => {
          fixture.respond(answer(messageBody('{"summary": "Vitest is', stopReason)));
          expect(await enrich()).toEqual({ ok: false, failure: "permanent", reason: "truncated" });
          expect(fixture.requests).toHaveLength(1);
        });
      }

      it("asks for the answer up to 16,000 tokens, so thinking has room", async () => {
        fixture.respond(output(VALID_OUTPUT));
        await enrich();
        expect(ANTHROPIC_MAX_TOKENS).toBe(16_000);
        expect(JSON.parse(fixture.requests[0]?.body ?? "")).toMatchObject({ max_tokens: 16_000 });
      });

      const invalid: [string, AnthropicResolver][] = [
        ["a body that isn't JSON", () => HttpResponse.text("not json")],
        ["a body that isn't a Message", answer({ completion: "{}" })],
        ["text that isn't JSON", answer(messageBody("Here is the description you asked for."))],
        ["no text block", answer({ ...messageBody(""), content: [] })],
        [
          // The structured outputs page puts the JSON in one text block, so two halves of it in
          // two blocks aren't joined.
          "two text blocks",
          answer({
            ...messageBody(""),
            content: [
              { type: "thinking", thinking: "", signature: "fixture-signature" },
              { type: "text", text: JSON.stringify(VALID_OUTPUT).slice(0, 40) },
              { type: "text", text: JSON.stringify(VALID_OUTPUT).slice(40) },
            ],
          }),
        ],
        [
          "two text blocks that are each valid JSON",
          answer({
            ...messageBody(""),
            content: [
              { type: "text", text: JSON.stringify(VALID_OUTPUT) },
              { type: "text", text: JSON.stringify({}) },
            ],
          }),
        ],
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
      it(`is sent only in the ${adapter.keyHeader} header, only to the configured base URL`, async () => {
        fixture.respond(output({}), output(VALID_OUTPUT));
        await write();
        expect(fixture.requests).toHaveLength(2);
        for (const request of fixture.requests) {
          expect(new URL(request.url).origin).toBe(adapter.origin);
          expect(request.url).not.toContain(KEY);
          expect(request.body).not.toContain(KEY);
          for (const [name, value] of request.headers) {
            expect(value.includes(KEY)).toBe(name === adapter.keyHeader);
          }
          expect(request.headers.get(adapter.keyHeader)).toBe(adapter.keyValue);
          expect(request.headers.get(adapter.otherKeyHeader)).toBeNull();
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

      it("is not in any result, which callers may log, and neither is any other credential", async () => {
        fixture.respond(status(401), output({}), output({}), output(VALID_OUTPUT));
        const results = JSON.stringify([await write(), await write(), await enrich()]);
        for (const credential of adapter.credentials) {
          expect(results).not.toContain(credential);
        }
      });

      // The harness and local development leave a required secret they can't find unbound, so
      // the value can be missing although `Env` says `string`.
      it.each([
        ["an empty string", ""],
        ["only whitespace", " "],
        ["a missing value", undefined as unknown as string],
      ])("refuses %s as the key, with a code that names it, before any request", async (_, key) => {
        const error = await adapter
          .withKey(key)
          .enrich(REPOSITORY_INPUT, { model: MODEL })
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({
          message: "ANTHROPIC_API_KEY is empty",
          code: "ANTHROPIC_API_KEY_EMPTY",
        });
        expect(fixture.requests).toEqual([]);
      });

      it.each([
        ["an empty string", ""],
        ["only whitespace", "  "],
        ["a missing value", undefined as unknown as string],
      ])(
        "refuses %s as the model, with a code that names it, before any request",
        async (_, model) => {
          const error = await provider
            .enrich(REPOSITORY_INPUT, { model })
            .catch((caught: unknown) => caught);
          expect(error).toMatchObject({
            message: "ANTHROPIC_MODEL is empty",
            code: "ANTHROPIC_MODEL_EMPTY",
          });
          expect(fixture.requests).toEqual([]);
        },
      );

      const { host } = new URL(adapter.origin);
      it.each([`http://${host}`, "http://example.com", `ftp://${host}`])(
        "is never sent to %s, which is neither https nor a loopback host",
        async (base) => {
          await expect(
            adapter.withBaseUrl(base).enrich(REPOSITORY_INPUT, { model: MODEL }),
          ).rejects.toThrow(
            `${adapter.baseUrlName} must be an https URL, or http on a loopback host`,
          );
          expect(fixture.requests).toEqual([]);
        },
      );

      // The enrichment module runs these checks before it asks Jev or GitHub anything (#126).
      describe("checkConfiguration", () => {
        it("throws what enrich() would for an empty key, an empty model or a base URL, and sends nothing", () => {
          expect(() => adapter.withKey("").checkConfiguration({ model: MODEL })).toThrow(
            expect.objectContaining({ code: "ANTHROPIC_API_KEY_EMPTY" }),
          );
          expect(() => provider.checkConfiguration({ model: "" })).toThrow(
            expect.objectContaining({ code: "ANTHROPIC_MODEL_EMPTY" }),
          );
          expect(() =>
            adapter.withBaseUrl("http://example.com").checkConfiguration({ model: MODEL }),
          ).toThrow(`${adapter.baseUrlName} must be an https URL, or http on a loopback host`);
          expect(fixture.requests).toEqual([]);
        });

        it("returns for a configuration enrich() accepts, and sends nothing", () => {
          expect(() => provider.checkConfiguration({ model: MODEL })).not.toThrow();
          expect(fixture.requests).toEqual([]);
        });
      });

      it("may be sent over http to a loopback host, where integration tests serve responses", async () => {
        fixture.respond(output(VALID_OUTPUT));
        const loopback = adapter.withBaseUrl(LOOPBACK_ORIGIN);
        expect(await loopback.enrich(REPOSITORY_INPUT, { model: MODEL })).toMatchObject({
          ok: true,
          output: VALID_OUTPUT,
        });
        expect(fixture.requests.map((request) => request.url)).toEqual([adapter.loopbackUrl]);
      });
    });
  });

  describe(`writeProseEnrichment, through ${adapter.name}`, () => {
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

    // Thinking counts toward `max_tokens`, and its length varies between identical requests.
    const truncated = () => HttpResponse.json(messageBody('{"summary": "Vitest is', "max_tokens"));

    it("succeeds after exactly two calls when the first answer is truncated", async () => {
      fixture.respond(truncated, output(VALID_OUTPUT));
      expect(await write()).toMatchObject({ ok: true, enrichment: VALID_OUTPUT, calls: 2 });
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests[1]?.body).toBe(fixture.requests[0]?.body);
    });

    it("fails permanently when the answer is truncated twice", async () => {
      fixture.respond(truncated, truncated);
      expect(await write()).toEqual({
        ok: false,
        failure: "permanent",
        reason: "truncated",
        calls: 2,
      });
      expect(fixture.requests).toHaveLength(2);
    });

    it("makes at most two calls when invalid output and a truncated answer alternate", async () => {
      fixture.respond(output({}), truncated);
      expect(await write()).toEqual({
        ok: false,
        failure: "permanent",
        reason: "truncated",
        calls: 2,
      });
      fixture.reset();
      fixture.respond(truncated, output({}));
      expect(await write()).toMatchObject({
        ok: false,
        failure: "permanent",
        reason: "invalid-output",
        calls: 2,
      });
      expect(fixture.requests).toHaveLength(2);
    });
  });
}

describe("messagesProvider", () => {
  // The key goes only in the header the adapter's keyHeader names, so an adapter can't add a
  // second credential, or the key in a header the provider doesn't read, in any letter case.
  for (const name of ["authorization", "Authorization", "x-api-key", "X-Api-Key"]) {
    it(`refuses an adapter whose own headers include ${name}, before sending anything`, async () => {
      const provider = messagesProvider(
        "test",
        {
          apiKey: KEY,
          keyHeader: "authorization",
          endpoint: () => ({ url: new URL(MESSAGES_URL), headers: { [name]: KEY } }),
        },
        timing,
      );
      await expect(provider.enrich(REPOSITORY_INPUT, { model: MODEL })).rejects.toMatchObject({
        code: "MESSAGES_KEY_HEADER_IN_HEADERS",
      });
      expect(fixture.requests).toHaveLength(0);
    });
  }
});

describe("anthropicProvider", () => {
  it("is the provider named anthropic", () => {
    expect(
      anthropicProvider({ ANTHROPIC_BASE_URL: ANTHROPIC_ORIGIN, ANTHROPIC_API_KEY: KEY }).id,
    ).toBe("anthropic");
  });

  it("sends none of the gateway's headers", async () => {
    fixture.respond(output(VALID_OUTPUT));
    await anthropicProvider(
      { ANTHROPIC_BASE_URL: ANTHROPIC_ORIGIN, ANTHROPIC_API_KEY: KEY },
      timing,
    ).enrich(REPOSITORY_INPUT, { model: MODEL });
    expect(fixture.requests).toHaveLength(1);
    const names = [...(fixture.requests[0]?.headers.keys() ?? [])];
    expect(names.filter((name) => name.startsWith("cf-aig-"))).toEqual([]);
  });
});

describe("aiGatewayProvider", () => {
  const provider = aiGatewayProvider(gatewayConfig, timing);

  function write() {
    return writeProseEnrichment(provider, REPOSITORY_INPUT, { model: MODEL });
  }

  function enrichWith(change: Partial<AiGatewayConfig>) {
    return aiGatewayProvider({ ...gatewayConfig, ...change }, timing)
      .enrich(REPOSITORY_INPUT, { model: MODEL })
      .catch((caught: unknown) => caught);
  }

  it("is the provider named ai-gateway", () => {
    expect(provider.id).toBe("ai-gateway");
  });

  it("checks the gateway's own configuration in checkConfiguration, and sends nothing", () => {
    expect(() =>
      aiGatewayProvider({ ...gatewayConfig, AI_GATEWAY_TOKEN: "" }, timing).checkConfiguration({
        model: MODEL,
      }),
    ).toThrow(expect.objectContaining({ code: "AI_GATEWAY_TOKEN_EMPTY" }));
    expect(() =>
      aiGatewayProvider({ ...gatewayConfig, AI_GATEWAY_ID: ".." }, timing).checkConfiguration({
        model: MODEL,
      }),
    ).toThrow(expect.objectContaining({ code: "AI_GATEWAY_ID_INVALID" }));
    expect(fixture.requests).toEqual([]);
  });

  it("sends the gateway's headers on every request, the validation retry included", async () => {
    fixture.respond(output({}), output(VALID_OUTPUT));
    expect(await write()).toMatchObject({ ok: true, calls: 2 });
    expect(fixture.requests).toHaveLength(2);
    for (const request of fixture.requests) {
      // Q7: the gateway logs the metadata and not the bodies.
      expect(request.headers.get("cf-aig-collect-log-payload")).toBe("false");
      // A cached invalid answer can't be returned to the retry.
      expect(request.headers.get("cf-aig-skip-cache")).toBe("true");
      expect(request.headers.get("cf-aig-authorization")).toBe(`Bearer ${TOKEN}`);
      // The gateway can't bill the request to Cloudflare credits instead of the Anthropic key.
      expect(request.headers.get("cf-aig-no-wholesale")).toBe("true");
      // The gateway passes the Anthropic key on from `x-api-key`. It answered a key in
      // `authorization` with a 400 on 2026-10-24, so that header isn't sent at all.
      expect(request.headers.get("x-api-key")).toBe(KEY);
      expect(request.headers.get("authorization")).toBeNull();
      // No other gateway setting is sent: no retries of the gateway's own, which would break
      // the one-request rule, and no time limit of its own.
      const names = [...request.headers.keys()].filter((name) => name.startsWith("cf-aig-"));
      expect(names.sort()).toEqual([
        "cf-aig-authorization",
        "cf-aig-collect-log-payload",
        "cf-aig-no-wholesale",
        "cf-aig-skip-cache",
      ]);
    }
  });

  it("sends the token only in cf-aig-authorization, only to the gateway", async () => {
    fixture.respond(output({}), output(VALID_OUTPUT));
    await write();
    expect(fixture.requests).toHaveLength(2);
    for (const request of fixture.requests) {
      expect(new URL(request.url).origin).toBe(GATEWAY_ORIGIN);
      expect(request.url).not.toContain(TOKEN);
      expect(request.body).not.toContain(TOKEN);
      for (const [name, value] of request.headers) {
        expect(value.includes(TOKEN)).toBe(name === "cf-aig-authorization");
      }
    }
  });

  it.each([
    [
      "whose bodies the gateway would log",
      { "x-api-key": KEY },
      "cf-aig-collect-log-payload: false",
    ],
    [
      "with the key in authorization",
      { "cf-aig-collect-log-payload": "false", authorization: `Bearer ${KEY}` },
      "the key in x-api-key alone",
    ],
    [
      "with an authorization header beside x-api-key",
      { "cf-aig-collect-log-payload": "false", "x-api-key": KEY, authorization: `Bearer ${KEY}` },
      "the key in x-api-key alone",
    ],
  ])("is checked by a fixture that fails a request %s", async (_, headers, missing) => {
    fixture.respond(output(VALID_OUTPUT));
    await expect(
      fetch(GATEWAY_MESSAGES_URL, { method: "POST", headers, body: "{}" }),
    ).rejects.toThrow();
    expect(fixture.unplanned).toEqual([`${GATEWAY_MESSAGES_URL} without ${missing}`]);
    // This test made the request on purpose, so the check after it mustn't fail.
    fixture.reset();
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", " "],
    ["a missing value", undefined as unknown as string],
  ])("refuses %s as the token, with a code that names it, before any request", async (_, token) => {
    expect(await enrichWith({ AI_GATEWAY_TOKEN: token })).toMatchObject({
      message: "AI_GATEWAY_TOKEN is empty",
      code: "AI_GATEWAY_TOKEN_EMPTY",
    });
    expect(fixture.requests).toEqual([]);
  });

  for (const name of ["AI_GATEWAY_ACCOUNT_ID", "AI_GATEWAY_ID"] as const) {
    it.each([
      ["an empty string", ""],
      ["only whitespace", " "],
      ["a missing value", undefined as unknown as string],
    ])(`refuses %s as ${name}, with a code that names it, before any request`, async (_, id) => {
      expect(await enrichWith({ [name]: id })).toMatchObject({
        message: `${name} is empty`,
        code: `${name}_EMPTY`,
      });
      expect(fixture.requests).toEqual([]);
    });

    // Each would change the path, or name a different one, if it were put in the URL as it is.
    it.each(["..", ".", "a/b", "../other", "%2e%2e", "a%2Fb", "a?b", "a#b", "a b", "a\\b"])(
      `refuses %s as ${name}, which isn't a plain ID, before any request`,
      async (id) => {
        expect(await enrichWith({ [name]: id })).toMatchObject({
          message: `${name} must have only letters, digits, hyphens and underscores`,
          code: `${name}_INVALID`,
        });
        expect(fixture.requests).toEqual([]);
      },
    );
  }
});
