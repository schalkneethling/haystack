// The setting that chooses the provider enrichment uses (#125): each `id` selects its adapter,
// with the model, and sends that adapter's request, and any other value is refused before
// anything is sent. Every request is answered by the Anthropic fixture (anthropic-fixture.ts),
// which fails a test that makes a request it did not plan for. See "The provider interface" and
// "Secrets and configuration" in plans/haystack-v1-implementation-plan.md.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { AnthropicTiming } from "../src/enrichment/anthropic-messages.ts";
import {
  chooseEnrichmentProvider,
  type ProviderSettingConfig,
} from "../src/enrichment/provider-setting.ts";
import {
  ANTHROPIC_ORIGIN,
  type AnthropicFixture,
  GATEWAY_ACCOUNT_ID,
  GATEWAY_ID,
  GATEWAY_MESSAGES_URL,
  GATEWAY_ORIGIN,
  MESSAGES_URL,
  output,
  startAnthropicFixture,
} from "./anthropic-fixture.ts";
import { REPOSITORY_INPUT, VALID_OUTPUT } from "./enrichment-output.ts";

const config: ProviderSettingConfig = {
  ENRICHMENT_PROVIDER: "anthropic",
  ANTHROPIC_BASE_URL: ANTHROPIC_ORIGIN,
  ANTHROPIC_API_KEY: "sk-ant-test-key-4d81b0c2",
  ANTHROPIC_MODEL: "claude-haiku-5-5",
  AI_GATEWAY_BASE_URL: GATEWAY_ORIGIN,
  AI_GATEWAY_ACCOUNT_ID: GATEWAY_ACCOUNT_ID,
  AI_GATEWAY_ID: GATEWAY_ID,
  AI_GATEWAY_TOKEN: "cf-aig-test-token-9e17a6d3",
};

const timing: AnthropicTiming = { requestTimeoutMs: 100 };

let fixture: AnthropicFixture;

beforeAll(() => {
  fixture = startAnthropicFixture();
});

afterAll(() => {
  fixture.close();
});

beforeEach(() => {
  fixture.reset();
});

afterEach(() => {
  expect(fixture.unplanned).toEqual([]);
});

describe("chooseEnrichmentProvider", () => {
  it.each([
    ["anthropic", MESSAGES_URL],
    ["ai-gateway", GATEWAY_MESSAGES_URL],
  ])(
    "chooses the %s adapter, with ANTHROPIC_MODEL, which posts to its endpoint",
    async (id, url) => {
      const { provider, model } = chooseEnrichmentProvider(
        { ...config, ENRICHMENT_PROVIDER: id },
        timing,
      );
      expect(provider.id).toBe(id);
      expect(model).toBe("claude-haiku-5-5");
      fixture.respond(output(VALID_OUTPUT));
      expect(await provider.enrich(REPOSITORY_INPUT, { model })).toMatchObject({
        ok: true,
        output: VALID_OUTPUT,
      });
      expect(fixture.requests.map((request) => request.url)).toEqual([url]);
    },
  );

  // A misspelling, a provider that has no adapter yet, a name in another case, names an object
  // has without defining them, and no value.
  it.each([
    ["aigateway", '"aigateway"'],
    ["openai", '"openai"'],
    ["Anthropic", '"Anthropic"'],
    ["", '""'],
    ["constructor", '"constructor"'],
    ["__proto__", '"__proto__"'],
    [undefined as unknown as string, "undefined"],
  ])("refuses %j, naming it and the known providers, before any request", (id, shown) => {
    let error: unknown;
    try {
      chooseEnrichmentProvider({ ...config, ENRICHMENT_PROVIDER: id }, timing);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      message: `ENRICHMENT_PROVIDER is ${shown}, which names no provider. The known providers are "anthropic", "ai-gateway".`,
      code: "ENRICHMENT_PROVIDER_UNKNOWN",
    });
    expect(fixture.requests).toEqual([]);
  });
});
