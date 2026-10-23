// The save link: the Worker's /save URL with a capture payload in its query. The extension's
// popup opens it, and the Worker redirects to it after reading a page for the address form. Both
// build it here, because the budget and the order in which fields are dropped must change
// together in both places. See "Captured payload from the extension" in
// plans/haystack-v1-implementation-plan.md.
import type { CaptureField, CapturePayload } from "./capture-payload.ts";

/**
 * The longest save link, in characters, that is built without dropping optional fields. The
 * Worker re-encodes a signed-out `/save` request into the sign-in redirect's `return_to`, so
 * each `%` in the save link becomes `%25` and each `+` (a space) becomes `%2B`, and the redirect
 * is longer than the save link. 8,000 keeps the longest redirect the caps allow under
 * Cloudflare's URL limit (see the plan). The Worker's test uses the same number, so the two
 * cannot disagree.
 */
export const SAVE_URL_BUDGET = 8000;

/** The Worker's save form for a payload. `origin` is an origin alone, without a slash. */
function saveUrl(origin: string, payload: CapturePayload): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(payload)) {
    parameters.set(name, value);
  }
  return `${origin}/save?${parameters.toString()}`;
}

// The fields that can be dropped: every one but the address and the title. The address is never
// dropped or cut, and the title is at most 200 code units, which encode to at most 1,800
// characters.
type DroppableField = Exclude<CaptureField, "url" | "title">;

// The optional fields dropped, in this order, while the save link is over the budget (the order
// is the plan's, in "Captured payload from the extension").
const DROP_ORDER = [
  "og_description",
  "description",
  "og_title",
  "og_site_name",
  "canonical_url",
] as const satisfies readonly DroppableField[];

// The cast is sound because `url` is the payload's only required field, and DroppableField
// excludes it, so what is left after removing a field is still a CapturePayload.
function without(payload: CapturePayload, field: DroppableField): CapturePayload {
  return Object.fromEntries(
    Object.entries(payload).filter(([name]) => name !== field),
  ) as CapturePayload;
}

/**
 * The save link for a validated payload, with optional fields dropped until the whole URL,
 * origin and `/save?` included, is within SAVE_URL_BUDGET. It measures the URL it returns, so
 * whatever encoding URLSearchParams gives it is what is counted, and it stops at the first URL
 * that fits. A `url` that passed validation encodes to at most 6,144 characters and a title to
 * at most 1,800, so with a short origin the two fit without the rest. A very long origin could
 * leave that pair a few characters over, and then the URL is returned as it is, because it is
 * still far below the 16 KB limit that the budget keeps clear of.
 *
 * Run it on the payload that is sent, after `withoutSensitiveCanonicalUrl`, so that a canonical
 * URL dropped for carrying a secret does not cost another field its place.
 */
export function saveUrlWithinBudget(origin: string, payload: CapturePayload): string {
  let kept = payload;
  let target = saveUrl(origin, kept);
  for (const field of DROP_ORDER) {
    if (target.length <= SAVE_URL_BUDGET) {
      break;
    }
    kept = without(kept, field);
    target = saveUrl(origin, kept);
  }
  return target;
}
