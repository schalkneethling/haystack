// The Messages API request that the Anthropic adapter (anthropic-provider.ts, #124) and the AI
// Gateway adapter (ai-gateway-provider.ts, #125) share. See "The provider interface", Q3, Q7 and
// "Secrets and configuration" in plans/haystack-v1-implementation-plan.md. The gateway's Anthropic
// endpoint takes Anthropic's request and returns Anthropic's response, so both adapters send the
// same body and read the answer the same way, and each supplies only its URL and its own headers.
// The shared contract test (test/enrichment-providers.test.ts) therefore checks one
// implementation behind two transports.
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
// - The Anthropic key is sent only in the one header the adapter chooses, `authorization` or
//   `x-api-key`, and only to the URL the adapter supplies, which each adapter builds from its own
//   base URL and checks is https, or http on a loopback host, where the integration tests'
//   recorded server runs (see "Testing strategy" in the plan). Redirects are not followed, so no
//   credential can be sent on to another address.
// - Nothing here logs. A failure is a fixed code and a status, which are safe to log. An error
//   response's body is read only to recognize a spend limit, and none of it is kept.
import * as v from "valibot";
import { readText } from "./bounded-read.ts";
import { configurationError } from "./configuration.ts";
import { enrichmentPrompt } from "./enrichment-prompt.ts";
import type { EnrichmentProvider, ProviderFailure, ProviderResult } from "./enrichment-provider.ts";
import { ENRICHMENT_JSON_SCHEMA } from "./enrichment-schema.ts";
import { statusFailureClass } from "./failure-class.ts";

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
 * and before any text. 16,000 is the claude-api skill's default for a request that isn't
 * streamed, and only the tokens generated are billed, not the limit.
 *
 * In practice the time limit above is the ceiling, not this one. The request isn't streamed, so
 * nothing arrives until the last token is generated, and 16,000 tokens in 20 seconds would take
 * 800 tokens a second. The Anthropic SDK (1.1.0, `calculateNonstreamingTimeout` in client.js)
 * sizes its own timeouts at 128,000 tokens an hour, about 36 a second. So thinking that runs long
 * ends as a transient `timeout` after one request, and an answer is `truncated`, which gets the
 * module's one retry, only if it reaches 16,000 tokens within the 20 seconds.
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

// An error response's body, in the shape the Errors page documents: "a top-level `error` object
// that always includes a `type` and `message` value". Only what the spend-limit check reads is
// checked. The gateway's own errors have another shape, such as `{"error":[{"code":2044,...}]}`
// (ai-gateway-provider.ts), so they never match.
const ErrorResponse = v.object({
  type: v.literal("error"),
  error: v.object({ type: v.string(), message: v.string() }),
});

/**
 * How the message of a `400` starts when usage reaches a spend limit that the organization or a
 * workspace set for itself (#154). "Rate limits"
 * (https://platform.claude.com/docs/en/api/rate-limits), read on 2026-10-25, says under "Setting
 * your own spend limit": "requests return HTTP 400 with error type `invalid_request_error`. The
 * message starts with `You have reached your specified API usage limits`, or `You have reached
 * your specified workspace API usage limits` for a workspace limit, and states when access
 * resumes." "Errors" (https://platform.claude.com/docs/en/api/errors), read the same day, says
 * "The API also returns a 400 when usage reaches an organization or workspace spend limit you
 * set". Neither page documents a code for it, as "Rate limits" does for the tier's monthly cap (a
 * `429` with `error.details.error_code: enforced_spend_limit_reached`, which is transient
 * anyway). So the documented starts of the message, with the status and the error type, are the
 * narrowest match there is. If Anthropic rewords the message, the `400` is permanent again, as it
 * was before.
 */
const SPEND_LIMIT_MESSAGE_STARTS = [
  "You have reached your specified API usage limits",
  "You have reached your specified workspace API usage limits",
] as const;

/**
 * How much of a `400`'s body is read to look for a spend limit. The Errors page's example body is
 * under 200 bytes, and a spend limit's message is two sentences, so 4 KiB is many times what the
 * error JSON needs, while a body that is something else, such as a proxy's HTML page, isn't
 * downloaded whole. A body cut at the limit is never taken for a spend limit, even when its
 * start parses, because a documented error body is a small fraction of that.
 */
export const ERROR_BODY_READ_LIMIT_BYTES = 4 * 1024;

// Whether a `400`'s body says a spend limit was reached. Nothing from the body is returned.
function isSpendLimit(body: string): boolean {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return false;
  }
  const parsed = v.safeParse(ErrorResponse, json);
  if (!parsed.success || parsed.output.error.type !== "invalid_request_error") {
    return false;
  }
  const { message } = parsed.output.error;
  return SPEND_LIMIT_MESSAGE_STARTS.some((start) => message.startsWith(start));
}

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
      const { status } = response;
      // A spend limit is Haystack's account, not the bookmark, so it stops the run like a 402
      // (#154). The body's start is read here, inside the time limit, and one that stops
      // arriving is a transient failure like any other.
      if (status === 400) {
        const read =
          response.body === null
            ? undefined
            : await readText(response.body, ERROR_BODY_READ_LIMIT_BYTES);
        if (read?.complete === true && isSpendLimit(read.text)) {
          return { ok: false, failure: "account", reason: "spend-limit", status };
        }
      } else {
        discard(response);
      }
      // The transient statuses are the ones #124 lists, by the Jev client's rule (408, 429, 529
      // and any other 5xx), and 401, 402 (billing_error) and 403 are the account (#127). The
      // errors page gives retry advice for only two statuses: "Retry the request with
      // exponential backoff" for 500 (api_error), and "Resolve the conflict, then retry the
      // request" for 409 (conflict_error), which stays permanent here, because the same request
      // would conflict again. It suggests streaming for 504 (timeout_error), and gives no advice
      // for 429 (rate_limit_error) or 529 (overloaded_error).
      return { ok: false, failure: statusFailureClass(status), reason: "status", status };
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
  // `model_context_window_exceeded` is a property of the input, which a retry can't change, but
  // it is folded in here because a prompt of this size, a few thousand tokens at most, can't
  // reach Claude Haiku 5.5's 1M-token window, so the retry it would waste can't happen in practice.
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

/** Where an adapter sends the request, and the headers it adds to the shared ones. */
export interface MessagesEndpoint {
  readonly url: URL;
  // The shared headers are set after these, so an adapter can't replace one of them. Neither key
  // header may be among them, in any case: the key goes only in the header `keyHeader` names.
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * How the Anthropic key is sent. The API overview page names `authorization: Bearer` as the way
 * to send an API key, and `x-api-key` as its legacy fallback, so Anthropic accepts either. The
 * Anthropic adapter uses `authorization`, and the AI Gateway adapter `x-api-key`, because the
 * gateway doesn't pass `authorization` on as Anthropic's credentials (ai-gateway-provider.ts).
 */
export type AnthropicKeyHeader = "authorization" | "x-api-key";

const KEY_HEADERS: ReadonlySet<string> = new Set<AnthropicKeyHeader>([
  "authorization",
  "x-api-key",
]);

function keyHeaders(header: AnthropicKeyHeader, apiKey: string): Record<string, string> {
  return header === "authorization"
    ? { authorization: `Bearer ${apiKey}` }
    : { "x-api-key": apiKey };
}

/** What an adapter supplies to the shared request. */
export interface MessagesTransport {
  readonly apiKey: string;
  // The one header the key is sent in.
  readonly keyHeader: AnthropicKeyHeader;
  /**
   * Builds the URL and the adapter's headers, and throws for the adapter's own configuration
   * errors. It is called on every `enrich()` and `checkConfiguration()` call, after the key and
   * the model are checked and before anything is sent.
   */
  endpoint(): MessagesEndpoint;
}

/**
 * A provider that sends one Messages API request per `enrich()` call, with the enrichment prompt
 * and the structured-output schema, to the transport's endpoint. It throws for an empty key or an
 * empty model, and for whatever the transport's `endpoint()` throws, before anything is sent,
 * because those are configuration errors rather than failures of the bookmark.
 * `checkConfiguration()` runs the same checks without sending anything.
 */
export function messagesProvider(
  id: string,
  transport: MessagesTransport,
  timing: AnthropicTiming,
): EnrichmentProvider {
  // The checks every request runs first, and its endpoint. `checkConfiguration()` runs them on
  // their own, so the enrichment module can find an error before it asks Jev or GitHub anything.
  const prepare = (model: string): MessagesEndpoint => {
    // An empty secret is easy to store by mistake (#98), and Anthropic would only answer 401.
    // The value can also be missing, although `Env` says `string`: the test harness and local
    // development don't bind a required secret they can't find.
    if (!transport.apiKey || transport.apiKey.trim() === "") {
      throw configurationError("ANTHROPIC_API_KEY is empty", "ANTHROPIC_API_KEY_EMPTY");
    }
    // The caller passes ANTHROPIC_MODEL. An empty one would only get a 400 for every bookmark,
    // each counted as a permanent failure.
    if (!model || model.trim() === "") {
      throw configurationError("ANTHROPIC_MODEL is empty", "ANTHROPIC_MODEL_EMPTY");
    }
    const endpoint = transport.endpoint();
    // An adapter's own `authorization` or `x-api-key` would send a second credential, or the
    // key in a header the provider doesn't read (#125). Header names aren't case-sensitive.
    for (const name of Object.keys(endpoint.headers ?? {})) {
      if (KEY_HEADERS.has(name.toLowerCase())) {
        throw configurationError(
          `An adapter's headers can't include ${name}; use keyHeader`,
          "MESSAGES_KEY_HEADER_IN_HEADERS",
        );
      }
    }
    return endpoint;
  };
  return {
    id,
    checkConfiguration({ model }) {
      prepare(model);
    },
    async enrich(input, { model }) {
      const { url, headers } = prepare(model);
      const { system, user } = enrichmentPrompt(input);
      const outcome = await request(
        url,
        {
          method: "POST",
          headers: {
            ...headers,
            ...keyHeaders(transport.keyHeader, transport.apiKey),
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
