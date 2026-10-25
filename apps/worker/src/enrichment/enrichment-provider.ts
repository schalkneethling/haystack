// The provider interface, and the one place an LLM's output is validated (#124). See "The provider
// interface", "Enrichment sweep" and Q3 in plans/haystack-v1-implementation-plan.md.
//
// An adapter, such as the Anthropic adapter (anthropic-provider.ts) or the AI Gateway adapter
// (ai-gateway-provider.ts), makes exactly one HTTP request per `enrich()` call and never retries.
// It returns the provider's output as `unknown`, or a classified failure. writeProseEnrichment
// validates the output against EnrichmentV1, and when it fails, or the output was cut off, asks
// the same provider once more. That is the only retry, so the LLM makes at most 2 requests per
// bookmark, as Q3 counts.
import * as v from "valibot";
import type { EnrichmentInput } from "./enrichment-prompt.ts";
import { EnrichmentV1 } from "./enrichment-schema.ts";
import type { FailureClass } from "./failure-class.ts";

/**
 * Why a provider gave no output, as a fixed code that is safe to log:
 * - `timeout`: the request took longer than its time limit, body included.
 * - `network`: the request failed, or the response's body stopped before its end.
 * - `status`: the provider answered with a status other than 2xx, which `status` holds.
 * - `invalid-response`: a 2xx response that isn't a complete answer, such as a body that isn't
 *   the provider's response format, or output that isn't JSON.
 * - `refused`: the model declined to answer, as a policy decision.
 * - `truncated`: the output stopped at the token limit or the context window, so it is incomplete.
 *   writeProseEnrichment asks once more, as it does for invalid output.
 */
export type ProviderFailureReason =
  | "timeout"
  | "network"
  | "status"
  | "invalid-response"
  | "refused"
  | "truncated";

export interface ProviderFailure {
  readonly ok: false;
  readonly failure: FailureClass;
  readonly reason: ProviderFailureReason;
  // The response's status, for a `status` failure.
  readonly status?: number;
}

export interface ProviderOutput {
  readonly ok: true;
  // The output, not yet validated.
  readonly output: unknown;
  // The model that answered, as the provider names it, for the enrichment row's `model`.
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ProviderResult = ProviderOutput | ProviderFailure;

/**
 * An LLM provider. `enrich()` makes exactly one HTTP request, with a time limit, and doesn't
 * retry. It resolves to a failure rather than throwing when the request fails, and throws only
 * for a configuration error, before anything is sent.
 */
export interface EnrichmentProvider {
  // The provider's name, for the enrichment row's `provider`.
  readonly id: string;
  /**
   * Throws for the configuration error that `enrich()` would throw with these options, and sends
   * nothing. The enrichment module calls it before it asks Jev or GitHub anything, so an empty
   * key doesn't cost a bookmark's Jev questions on every run (#126).
   */
  checkConfiguration(options: { readonly model: string }): void;
  enrich(input: EnrichmentInput, options: { readonly model: string }): Promise<ProviderResult>;
}

/**
 * Why the output failed EnrichmentV1, as `<path>: <check>`, such as `use_cases.2: max_length`.
 * It names only the schema's keys, list positions and Valibot's check names, never a value, so
 * it is safe to log and to store in `last_error`.
 */
export type ValidationIssue = string;

export interface ProseEnrichmentFailure {
  readonly ok: false;
  readonly failure: FailureClass;
  // `invalid-output`: the output failed EnrichmentV1 on both calls.
  readonly reason: ProviderFailureReason | "invalid-output";
  readonly status?: number;
  // The second output's first issue, for an `invalid-output` failure.
  readonly issue?: ValidationIssue;
  // How many times the provider was called: 1 or 2.
  readonly calls: number;
}

export interface ProseEnrichmentSuccess {
  readonly ok: true;
  readonly enrichment: EnrichmentV1;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly calls: number;
}

export type ProseEnrichmentResult = ProseEnrichmentSuccess | ProseEnrichmentFailure;

// How many times the provider is asked when its output fails validation or is cut off.
const CALL_LIMIT = 2;

// A key the output has but the schema doesn't name is the model's own text, which could repeat
// captured text, so it is never written out.
function describePathItem(item: v.IssuePathItem): string {
  if (typeof item.key === "number") {
    return String(item.key);
  }
  return typeof item.key === "string" && Object.hasOwn(EnrichmentV1.entries, item.key)
    ? item.key
    : "(unknown key)";
}

function describeIssue(issue: v.BaseIssue<unknown>): ValidationIssue {
  const path = (issue.path ?? []).map(describePathItem).join(".");
  return `${path === "" ? "(output)" : path}: ${issue.type}`;
}

/**
 * Asks the provider for the bookmark's prose enrichment and validates it. Output that fails
 * validation, or that was cut off at the token limit (`truncated`), is asked for once more, from
 * the same provider with the same input, and a second failure is permanent. A truncated answer
 * gets the retry because it is usually the thinking, whose length varies between identical
 * requests, that used up the tokens. Any other failure of the request is returned as it is: a
 * transient one is left to the sweep, and a permanent one would fail again.
 */
export async function writeProseEnrichment(
  provider: EnrichmentProvider,
  input: EnrichmentInput,
  options: { readonly model: string },
): Promise<ProseEnrichmentResult> {
  for (let calls = 1; ; calls += 1) {
    const result = await provider.enrich(input, options);
    if (!result.ok) {
      if (result.reason === "truncated" && calls < CALL_LIMIT) {
        continue;
      }
      const { failure, reason, status } = result;
      return { ok: false, failure, reason, ...(status === undefined ? {} : { status }), calls };
    }
    const parsed = v.safeParse(EnrichmentV1, result.output);
    if (parsed.success) {
      const { model, inputTokens, outputTokens } = result;
      return { ok: true, enrichment: parsed.output, model, inputTokens, outputTokens, calls };
    }
    if (calls === CALL_LIMIT) {
      return {
        ok: false,
        failure: "permanent",
        reason: "invalid-output",
        issue: describeIssue(parsed.issues[0]),
        calls,
      };
    }
  }
}
