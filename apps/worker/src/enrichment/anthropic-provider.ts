// The Anthropic adapter for the provider interface (#124). See "The provider interface", Q3, Q7
// and "Secrets and configuration" in plans/haystack-v1-implementation-plan.md. Nothing in
// production calls it yet: the enrichment module (#126) is its first caller, through
// chooseEnrichmentProvider (provider-setting.ts).
//
// It sends the Messages API request in anthropic-messages.ts, which the AI Gateway adapter
// (ai-gateway-provider.ts) shares, straight to Anthropic. That module has the request, its
// limits and how its failures are classified. This one supplies only the URL:
// - The key is sent only to ANTHROPIC_BASE_URL, and only over https, or over http to a loopback
//   host, where the integration tests' recorded server runs (see "Testing strategy" in the plan).
import { isHttpsOrLoopbackUrl } from "@haystack/schemas";
import { type AnthropicTiming, ANTHROPIC_TIMING, messagesProvider } from "./anthropic-messages.ts";
import type { EnrichmentProvider } from "./enrichment-provider.ts";

/** The configuration the adapter reads. `Env` has these, from `vars` and `secrets.required`. */
export interface AnthropicConfig {
  // The Claude API's origin. The request goes to `/v1/messages` on it.
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_API_KEY: string;
}

/**
 * The Anthropic adapter. Each `enrich()` call sends one request to `/v1/messages` with the
 * enrichment prompt and the structured-output schema. It throws for an empty key, an empty model,
 * or a base URL that is neither https nor http on a loopback host, before anything is sent,
 * because those are configuration errors rather than failures of the bookmark.
 */
export function anthropicProvider(
  config: AnthropicConfig,
  timing: AnthropicTiming = ANTHROPIC_TIMING,
): EnrichmentProvider {
  return messagesProvider(
    "anthropic",
    {
      apiKey: config.ANTHROPIC_API_KEY,
      // The overview page names `authorization: Bearer` as the way to send an API key.
      keyHeader: "authorization",
      endpoint() {
        const url = new URL("/v1/messages", config.ANTHROPIC_BASE_URL);
        if (!isHttpsOrLoopbackUrl(url)) {
          throw new TypeError(
            "ANTHROPIC_BASE_URL must be an https URL, or http on a loopback host",
          );
        }
        return { url };
      },
    },
    timing,
  );
}
