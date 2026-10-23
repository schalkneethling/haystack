// The Anthropic adapter for the provider interface (#124). See "The provider interface", Q3, Q7
// and "Secrets and configuration" in plans/haystack-v1-implementation-plan.md. Nothing in
// production calls it yet: the enrichment module (#126) is its first caller.
//
// It calls the Messages API with `fetch`, not the Anthropic SDK, so each `enrich()` call is
// exactly one HTTP request: the SDK retries twice by default, and waits up to 10 minutes. The
// request and response fields, the headers and the statuses come from Anthropic's documentation,
// read on 2026-10-23: the Messages API reference (https://platform.claude.com/docs/en/api/messages),
// "Structured outputs" (https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
// "Errors" (https://platform.claude.com/docs/en/api/errors), "API overview"
// (https://platform.claude.com/docs/en/api/overview) and "Versions"
// (https://platform.claude.com/docs/en/api/versioning).
//
// The limits:
// - One request per `enrich()` call, never retried here. The module's validation retry
//   (enrichment-provider.ts) is the only retry, so Q3 counts at most 2 requests per bookmark.
// - The request, from sending it to the last byte of the response, stops after
//   `requestTimeoutMs`.
// - The key is sent only in the `authorization` header, only to ANTHROPIC_BASE_URL, and only
//   over https, or over http to a loopback host, where the integration tests' recorded server
//   runs (see "Testing strategy" in the plan). Redirects are not followed, so the key can't be
//   sent on to another address.
// - Nothing here logs. A failure is a fixed code and a status, which are safe to log.
import { isHttpsOrLoopbackUrl } from "@haystack/schemas";
import * as v from "valibot";
import { enrichmentPrompt } from "./enrichment-prompt.ts";
import type { EnrichmentProvider, ProviderFailure, ProviderResult } from "./enrichment-provider.ts";
import { ENRICHMENT_JSON_SCHEMA } from "./enrichment-schema.ts";
import { isTransientStatus } from "./failure-class.ts";

/** The configuration the adapter reads. `Env` has these, from `vars` and `secrets.required`. */
export interface AnthropicConfig {
  // The Claude API's origin. The request goes to `/v1/messages` on it.
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_API_KEY: string;
}

/**
 * The API version the request is written against. 2026-10-21 is the newest, which the Versions
 * page recommends. Its changes to the Messages API are about fields this request doesn't send.
 */
export const ANTHROPIC_VERSION = "2026-10-21";

/**
 * How long the request may take, body included. The output is at most a few hundred words, so
 * this is several times what it should take, and it bounds a bookmark's two LLM calls at 40
 * seconds. The documentation gives no response times.
 */
export const ANTHROPIC_REQUEST_TIMEOUT_MS = 20_000;

/**
 * The most tokens the model may generate, thinking included. The longest valid output is about
 * 4,000 characters of JSON, under 2,000 tokens, but thinking counts toward the limit too, and the
 * Claude Haiku 5.5 migration guide warns that a small limit can stop an answer after its thinking
 * and before any text. How long the model thinks varies between identical requests, so the limit
 * leaves thinking plenty of room: 16,000 is the claude-api skill's default for a request that
 * isn't streamed. Only the tokens generated are billed, not the limit, and the time limit above
 * ends a request that would run long. An answer that still reaches it is `truncated`.
 */
export const ANTHROPIC_MAX_TOKENS = 16_000;

/**
 * How much the model thinks. The task is a short extraction from a few hundred words of
 * evidence, which the effort guidance puts at `low`. Claude Haiku 5.5 thinks by default, and
 * lowering the effort is the documented way to make it think less.
 */
const EFFORT = "low";

/** The time limit. The tests shorten it. */
export interface AnthropicTiming {
  readonly requestTimeoutMs: number;
}

export const ANTHROPIC_TIMING: AnthropicTiming = {
  requestTimeoutMs: ANTHROPIC_REQUEST_TIMEOUT_MS,
};

// The fields of a Message that Haystack reads. Fields it doesn't read, such as `id` and the
// thinking blocks' contents, aren't checked, so a change to them can't fail an answer.
const MessageResponse = v.object({
  model: v.pipe(v.string(), v.nonEmpty()),
  stop_reason: v.string(),
  // The Messages API reference documents `stop_details` as a RefusalStopDetails (`type:
  // "refusal"`, a category and an explanation) or null. The claude-api skill says it is set only
  // when `stop_reason` is `refusal`, but the reference's example response has it with
  // `stop_reason: "end_turn"`, so it is read whatever the stop reason says.
  stop_details: v.nullish(v.object({ type: v.string() })),
  content: v.array(v.object({ type: v.string(), text: v.optional(v.string()) })),
  usage: v.object({
    input_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
    output_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
});

type RequestOutcome = { readonly ok: true; readonly body: string } | ProviderFailure;

function discard(response: Response): void {
  response.body?.cancel().catch(() => {
    // Nothing more is wanted from this response.
  });
}

async function request(url: URL, init: RequestInit, timeoutMs: number): Promise<RequestOutcome> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) {
      discard(response);
      const { status } = response;
      // The transient statuses are the ones #124 lists, by the Jev client's rule (408, 429, 529
      // and any other 5xx). The errors page gives retry advice for only two statuses: "Retry the
      // request with exponential backoff" for 500 (api_error), and "Resolve the conflict, then
      // retry the request" for 409 (conflict_error), which stays permanent here, because the
      // same request would conflict again. It suggests streaming for 504 (timeout_error), and
      // gives no advice for 429 (rate_limit_error) or 529 (overloaded_error).
      return {
        ok: false,
        failure: isTransientStatus(status) ? "transient" : "permanent",
        reason: "status",
        status,
      };
    }
    // Read here, inside the time limit, so a body that stops arriving times out too.
    return { ok: true, body: await response.text() };
  } catch {
    return { ok: false, failure: "transient", reason: signal.aborted ? "timeout" : "network" };
  }
}

const invalidResponse: ProviderFailure = {
  ok: false,
  failure: "permanent",
  reason: "invalid-response",
};

// The output in a 2xx response's body: the JSON in its text block. Thinking blocks come first and
// are skipped. The structured outputs page says the JSON is in "the response's text content
// block", one block, so a response with no text block or with more than one isn't the answer it
// describes, and isn't pieced together.
function parseOutput(body: string): ProviderResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return invalidResponse;
  }
  const parsed = v.safeParse(MessageResponse, json);
  if (!parsed.success) {
    return invalidResponse;
  }
  const { model, stop_reason, stop_details, content, usage } = parsed.output;
  // A refusal is a policy decision about this input, so asking again would most likely be
  // refused again. Its text may not match the schema.
  if (stop_reason === "refusal" || stop_details?.type === "refusal") {
    return { ok: false, failure: "permanent", reason: "refused" };
  }
  // The output stopped early, so it is incomplete JSON. Most often the thinking took the tokens,
  // and how long the model thinks varies, so writeProseEnrichment asks once more, as it does for
  // invalid output. The class is permanent, because a second one is.
  if (stop_reason === "max_tokens" || stop_reason === "model_context_window_exceeded") {
    return { ok: false, failure: "permanent", reason: "truncated" };
  }
  // The request has no tools and no stop sequences, so the model can only end its turn.
  if (stop_reason !== "end_turn") {
    return invalidResponse;
  }
  const texts = content.filter((block) => block.type === "text");
  const text = texts[0]?.text;
  if (texts.length !== 1 || text === undefined) {
    return invalidResponse;
  }
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    return invalidResponse;
  }
  return {
    ok: true,
    output,
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
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
  return {
    id: "anthropic",
    async enrich(input, { model }) {
      // An empty secret is easy to store by mistake (#98), and Anthropic would only answer 401.
      // The value can also be missing, although `Env` says `string`: the test harness and local
      // development don't bind a required secret they can't find.
      if (!config.ANTHROPIC_API_KEY || config.ANTHROPIC_API_KEY.trim() === "") {
        throw Object.assign(new Error("ANTHROPIC_API_KEY is empty"), {
          code: "ANTHROPIC_API_KEY_EMPTY",
        });
      }
      // The caller passes ANTHROPIC_MODEL. An empty one would only get a 400 for every bookmark,
      // each counted as a permanent failure.
      if (!model || model.trim() === "") {
        throw Object.assign(new Error("ANTHROPIC_MODEL is empty"), {
          code: "ANTHROPIC_MODEL_EMPTY",
        });
      }
      const url = new URL("/v1/messages", config.ANTHROPIC_BASE_URL);
      if (!isHttpsOrLoopbackUrl(url)) {
        throw new TypeError("ANTHROPIC_BASE_URL must be an https URL, or http on a loopback host");
      }
      const { system, user } = enrichmentPrompt(input);
      const outcome = await request(
        url,
        {
          method: "POST",
          headers: {
            // The overview page names `authorization: Bearer` as the way to send an API key, and
            // `x-api-key` as its legacy fallback.
            authorization: `Bearer ${config.ANTHROPIC_API_KEY}`,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: ANTHROPIC_MAX_TOKENS,
            system,
            messages: [{ role: "user", content: user }],
            output_config: {
              effort: EFFORT,
              format: { type: "json_schema", schema: ENRICHMENT_JSON_SCHEMA },
            },
          }),
          redirect: "manual",
        },
        timing.requestTimeoutMs,
      );
      return outcome.ok ? parseOutput(outcome.body) : outcome;
    },
  };
}
