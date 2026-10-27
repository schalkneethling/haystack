// What both the extension's popup and the Worker's /save do with a canonical URL that carries
// a secret. See "Sensitive URLs" in plans/haystack-v1-implementation-plan.md.
import { type CapturePayload, SENSITIVE_CANONICAL_DROPPED } from "./capture-payload.ts";
import { detectSensitiveUrl } from "./detect-sensitive-url.ts";

/**
 * The payload without its canonical URL when `detectSensitiveUrl` flags that URL, and the same
 * payload otherwise. The page itself is not refused, because its own address has already passed
 * the check and is what the user chose to save. The canonical URL is only enrichment evidence
 * that the user never sees or edits, so leaving it out costs the bookmark nothing. A canonical
 * URL that does not parse is dropped too, so the function cannot throw for a payload that was
 * not validated.
 *
 * When it drops a flagged URL, it reports that in the payload it returns, by setting
 * `sensitive_canonical_dropped` to "1" (#131). The flag is a fact about the drop, and the URL
 * itself is never kept. A URL that does not parse is not flagged, so it sets nothing. A flag that
 * the payload already carries stays, because a link can bring one from the popup or the form.
 * `declaredSensitiveCanonical` reads the result.
 */
export function withoutSensitiveCanonicalUrl(payload: CapturePayload): CapturePayload {
  if (payload.canonical_url === undefined) {
    return payload;
  }
  const canonical = URL.parse(payload.canonical_url);
  const flagged = canonical !== null && detectSensitiveUrl(canonical) !== undefined;
  if (canonical !== null && !flagged) {
    return payload;
  }
  const { canonical_url: _dropped, ...rest } = payload;
  return flagged ? { ...rest, [SENSITIVE_CANONICAL_DROPPED]: "1" } : rest;
}
