// How enrichment classifies a failed request to a service it pays for, Jev and the LLM providers.
// See "Enrichment sweep" in plans/haystack-v1-implementation-plan.md. The Jev client (#122) and
// the LLM adapters (#124, #125) share this rule, so a status can't be transient for one service
// and permanent for another. The GitHub client has its own rule, because a GitHub failure never
// fails the bookmark (see "GitHub enrichment").

/**
 * A transient failure may succeed later, and enrichment only records it. A permanent one
 * won't, and counts toward the attempt limit.
 */
export type FailureClass = "transient" | "permanent";

/**
 * Whether a status other than 2xx is worth trying again later. A 408 is a timeout, a 429 a rate
 * limit, a 529 an overload, and any other 5xx a failure on the service's side, so all of them
 * are transient. A redirect and any other 4xx are permanent: the same request would get the same
 * answer.
 */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
