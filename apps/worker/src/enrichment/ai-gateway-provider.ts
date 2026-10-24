// The Cloudflare AI Gateway adapter for the provider interface (#125). See "The provider
// interface", Q3, Q7 and "Secrets and configuration" in plans/haystack-v1-implementation-plan.md.
// Nothing in production calls it yet: the enrichment module (#126) is its first caller, through
// chooseEnrichmentProvider (provider-setting.ts).
//
// It sends the same Messages API request as the Anthropic adapter (anthropic-messages.ts) to the
// gateway's Anthropic endpoint, which passes it on to Anthropic. That module has the request, its
// limits and how its failures are classified. The endpoint, the headers and the settings come
// from Cloudflare's AI Gateway documentation, read on 2026-10-24: Anthropic
// (https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/), Authenticated
// Gateway (https://developers.cloudflare.com/ai-gateway/configuration/authentication/), Logging
// (https://developers.cloudflare.com/ai-gateway/observability/logging/), Caching
// (https://developers.cloudflare.com/ai-gateway/features/caching/), Request handling
// (https://developers.cloudflare.com/ai-gateway/configuration/request-handling/), Manage gateways
// (https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/), Unified Billing
// (https://developers.cloudflare.com/ai-gateway/features/unified-billing/) and Troubleshooting
// (https://developers.cloudflare.com/ai-gateway/reference/troubleshooting/).
//
// - The endpoint is the provider-specific one, `/v1/{account_id}/{gateway_id}/anthropic`, with
//   Anthropic's `/v1/messages` after it, so the request and the response are Anthropic's. The
//   Authentication page recommends the REST API at api.cloudflare.com for new integrations and
//   says these endpoints "continue to work". The REST API's Messages endpoint was not chosen,
//   because it bills third-party models through Unified Billing rather than with Haystack's own
//   Anthropic key. The Logging page doesn't say which endpoints honour
//   `cf-aig-collect-log-payload`, which Q7's decision rests on, and its examples use the REST
//   API, so the check in "Deploys" in the plan confirms it for this endpoint before #126 ships.
// - The gateway is authenticated. Its token goes in `cf-aig-authorization`, and the Anthropic key
//   stays in `authorization`, which the gateway passes on: Troubleshooting says "The
//   `Authorization` header is reserved for provider credentials", and Unified Billing says that
//   when a request "carries provider authentication (for example, an `Authorization` header), AI
//   Gateway forwards it to the provider unchanged". No key is stored in the gateway.
// - Both credentials go only to AI_GATEWAY_BASE_URL, and only over https, or over http to a
//   loopback host, where the integration tests' recorded server runs (see "Testing strategy").
// - The documentation doesn't say what the gateway itself answers for a missing or wrong token or
//   an unknown gateway, so its own errors are classified by their status, as Anthropic's are.
// - The gateway's own retries stay off, so the one-request rule holds there too: its Retry
//   Requests setting is off (see "Deploys" in the plan), and no `cf-aig-max-attempts` header is
//   sent, because Request handling doesn't say whether its count includes the first request. No
//   `cf-aig-request-timeout` is sent either: the shared time limit covers the whole request.
import { isHttpsOrLoopbackUrl } from "@haystack/schemas";
import {
  type AnthropicTiming,
  ANTHROPIC_TIMING,
  configurationError,
  messagesProvider,
} from "./anthropic-messages.ts";
import type { EnrichmentProvider } from "./enrichment-provider.ts";

/** The configuration the adapter reads. `Env` has these, from `vars` and `secrets.required`. */
export interface AiGatewayConfig {
  // The gateway's origin, https://gateway.ai.cloudflare.com, a `var` so tests can point it at the
  // fixture. The request goes to `/v1/{account_id}/{gateway_id}/anthropic/v1/messages` on it.
  AI_GATEWAY_BASE_URL: string;
  // The Cloudflare account's ID, which isn't a secret.
  AI_GATEWAY_ACCOUNT_ID: string;
  // The gateway's ID, the name it was created with.
  AI_GATEWAY_ID: string;
  // The gateway's authentication token, created in the gateway's settings.
  AI_GATEWAY_TOKEN: string;
  // The gateway passes this on to Anthropic.
  ANTHROPIC_API_KEY: string;
}

// The two IDs are path segments, so a value is accepted only when it is made of characters that
// can't change the path: no `/`, no `.` (so never `.` or `..`), no `%` (so nothing that decodes
// to either), and no `?` or `#`. A value outside this is refused rather than percent-encoded,
// because the URL parser still treats `%2e%2e` as `..` (`new URL` drops the segment before it),
// and because an encoded ID would only name a gateway that doesn't exist, which every bookmark
// would then fail against. Haystack's account ID and `haystack` both fit.
const PATH_SEGMENT_ID = /^[A-Za-z0-9_-]+$/;

function requireId(name: "AI_GATEWAY_ACCOUNT_ID" | "AI_GATEWAY_ID", value: string): string {
  // The value can be missing, although `Env` says `string`, when a test's configuration leaves it
  // out.
  if (!value || value.trim() === "") {
    throw configurationError(`${name} is empty`, `${name}_EMPTY`);
  }
  if (!PATH_SEGMENT_ID.test(value)) {
    throw configurationError(
      `${name} must have only letters, digits, hyphens and underscores`,
      `${name}_INVALID`,
    );
  }
  return value;
}

/**
 * The AI Gateway adapter. Each `enrich()` call sends one request through the gateway to
 * Anthropic, with the enrichment prompt and the structured-output schema. It throws for an empty
 * gateway token, Anthropic key or model, for an account or gateway ID that is empty or isn't a
 * plain ID, and for a base URL that is neither https nor http on a loopback host, before anything
 * is sent, because those are configuration errors rather than failures of the bookmark.
 */
export function aiGatewayProvider(
  config: AiGatewayConfig,
  timing: AnthropicTiming = ANTHROPIC_TIMING,
): EnrichmentProvider {
  return messagesProvider(
    "ai-gateway",
    {
      apiKey: config.ANTHROPIC_API_KEY,
      endpoint() {
        // An empty token would get the gateway's error for every bookmark (#98).
        if (!config.AI_GATEWAY_TOKEN || config.AI_GATEWAY_TOKEN.trim() === "") {
          throw configurationError("AI_GATEWAY_TOKEN is empty", "AI_GATEWAY_TOKEN_EMPTY");
        }
        const account = requireId("AI_GATEWAY_ACCOUNT_ID", config.AI_GATEWAY_ACCOUNT_ID);
        const gateway = requireId("AI_GATEWAY_ID", config.AI_GATEWAY_ID);
        const url = new URL(
          `/v1/${account}/${gateway}/anthropic/v1/messages`,
          config.AI_GATEWAY_BASE_URL,
        );
        if (!isHttpsOrLoopbackUrl(url)) {
          throw new TypeError(
            "AI_GATEWAY_BASE_URL must be an https URL, or http on a loopback host",
          );
        }
        return {
          url,
          headers: {
            // Authentication: the provider endpoints take the token in this header.
            "cf-aig-authorization": `Bearer ${config.AI_GATEWAY_TOKEN}`,
            // Q7: metadata only. The Logging page says this skips storing the bodies, while
            // "metadata such as token counts, model, provider, status code, cost, and duration
            // will still be logged". It describes no gateway-wide setting for the bodies, so this
            // header is where the decision is set, on every request, the validation retry
            // included.
            "cf-aig-collect-log-payload": "false",
            // Caching is off by default, but if it were turned on, the validation retry, which
            // sends the same request again, could be answered with the same cached invalid output.
            "cf-aig-skip-cache": "true",
            // Costs stay on Haystack's Anthropic account. The Unified Billing page says the
            // gateway's "Require provider credentials" setting makes a request without
            // credentials it can use return "an HTTP `400` response instead of using
            // Cloudflare-managed credentials", and that this header does the same for one request:
            // it "can prevent Unified Billing fallback". So the gateway can never bill a request
            // to Cloudflare credits. The setting is on too (see "Deploys" in the plan).
            "cf-aig-no-wholesale": "true",
          },
        };
      },
    },
    timing,
  );
}
