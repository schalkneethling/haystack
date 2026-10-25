// How enrichment classifies a failed request to a service it pays for, Jev and the LLM providers.
// See "Enrichment sweep" in plans/haystack-v1-implementation-plan.md. The Jev client (#122) and
// the LLM adapters (#124, #125) share this rule, so a status can't be transient for one service
// and permanent for another. The GitHub client has its own rule, because a GitHub failure never
// fails the bookmark (see "GitHub enrichment").

/**
 * A failure of the bookmark. A transient one may succeed later, and enrichment records it,
 * counting only every TRANSIENT_FAILURES_PER_ATTEMPT-th one in a row as an attempt
 * (enrich-bookmark.ts). A permanent one won't succeed, and counts toward the attempt limit.
 */
export type BookmarkFailureClass = "transient" | "permanent";

/**
 * How a failed request is classified. `account` means the service rejected Haystack's own
 * account rather than the bookmark: its key, its billing or a spend limit it set. Every bookmark
 * would fail the same way until that is fixed, so the enrichment module records nothing against
 * the bookmark and tells its caller to stop the run (#127).
 */
export type FailureClass = BookmarkFailureClass | "account";

/**
 * The class of a status other than 2xx. A 401 is a missing or rejected key, a 402 a billing
 * problem (Anthropic's `billing_error`), and a 403 a key without permission, so all three are
 * about the account. TypeSafe's errors page documents a 401 but no 402 or 403, so for Jev those
 * two have their HTTP meaning. A 408 is a timeout, a 429 a rate limit, a 529 an overload, and any
 * other 5xx a failure on the service's side, so all of them are transient. A redirect and any
 * other 4xx are permanent: the same request would get the same answer. The Messages request
 * (anthropic-messages.ts) reads one `400` more closely, because Anthropic answers a spend limit
 * with it (#154).
 */
export function statusFailureClass(status: number): FailureClass {
  if (status === 401 || status === 402 || status === 403) {
    return "account";
  }
  return status === 408 || status === 429 || status >= 500 ? "transient" : "permanent";
}
