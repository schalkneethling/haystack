// What both the extension's popup and the Worker's /save do with a canonical URL that carries
// a secret. See "Sensitive URLs" in plans/haystack-v1-implementation-plan.md.
import type { CapturePayload } from "./capture-payload.ts";
import { detectSensitiveUrl } from "./detect-sensitive-url.ts";

/**
 * The payload without its canonical URL when `detectSensitiveUrl` flags that URL, and the same
 * payload otherwise. The page itself is not refused, because its own address has already passed
 * the check and is what the user chose to save. The canonical URL is only enrichment evidence
 * that the user never sees or edits, so leaving it out costs the bookmark nothing. Pass a
 * validated payload, whose canonical URL is a URL as submitted.
 */
export function withoutSensitiveCanonicalUrl(payload: CapturePayload): CapturePayload {
  if (payload.canonical_url === undefined) {
    return payload;
  }
  if (detectSensitiveUrl(new URL(payload.canonical_url)) === undefined) {
    return payload;
  }
  const { canonical_url: _flagged, ...rest } = payload;
  return rest;
}
