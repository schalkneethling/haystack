// The setting that chooses which provider enrichment uses (#125). See "The provider interface"
// and "Secrets and configuration" in plans/haystack-v1-implementation-plan.md. Its caller
// is the enrichment module (#126), which the scheduled sweep (#128) runs in production.
//
// ENRICHMENT_PROVIDER is a `var`, not a Flagship flag, because changing the provider changes who
// receives every bookmark's data, so it should be a reviewed change that goes through a deploy,
// like ALLOWED_EMAILS. The plan's list of runtime switches doesn't include it.
import { type AiGatewayConfig, aiGatewayProvider } from "./ai-gateway-provider.ts";
import { type AnthropicTiming, ANTHROPIC_TIMING } from "./anthropic-messages.ts";
import { type AnthropicConfig, anthropicProvider } from "./anthropic-provider.ts";
import { configurationError } from "./configuration.ts";
import type { EnrichmentProvider } from "./enrichment-provider.ts";

/** The configuration the setting reads. `Env` has these, from `vars` and `secrets.required`. */
export interface ProviderSettingConfig extends AnthropicConfig, AiGatewayConfig {
  // The provider's `id`.
  ENRICHMENT_PROVIDER: string;
  // The model for both providers, because the gateway passes the request on to Anthropic. A
  // separate gateway model would let the two disagree, and then a comparison of the two would be
  // comparing models, not transports.
  ANTHROPIC_MODEL: string;
}

/** The chosen provider, and the model to pass to its `enrich()`. */
export interface ChosenProvider {
  readonly provider: EnrichmentProvider;
  readonly model: string;
}

type ProviderFactory = (
  config: ProviderSettingConfig,
  timing: AnthropicTiming,
) => EnrichmentProvider;

// Each provider by its `id`. A Map, so a name such as `constructor` can't find a property that an
// object inherits.
const PROVIDERS = new Map<string, ProviderFactory>([
  ["anthropic", anthropicProvider],
  ["ai-gateway", aiGatewayProvider],
]);

/**
 * The provider that ENRICHMENT_PROVIDER names, with its model. An `id` that names no provider
 * throws, with the value and the known `id`s, before anything is sent. It never falls back to
 * another provider, because that would send bookmarks somewhere the setting didn't choose. The
 * on-save caller can pass a shorter time limit (see "The provider interface").
 */
export function chooseEnrichmentProvider(
  config: ProviderSettingConfig,
  timing: AnthropicTiming = ANTHROPIC_TIMING,
): ChosenProvider {
  const id = config.ENRICHMENT_PROVIDER;
  const factory = PROVIDERS.get(id);
  if (factory === undefined) {
    const known = [...PROVIDERS.keys()].map((name) => JSON.stringify(name)).join(", ");
    throw configurationError(
      `ENRICHMENT_PROVIDER is ${JSON.stringify(id)}, which names no provider. The known providers are ${known}.`,
      "ENRICHMENT_PROVIDER_UNKNOWN",
    );
  }
  return { provider: factory(config, timing), model: config.ANTHROPIC_MODEL };
}
