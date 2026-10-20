// What a page says about itself, and how it becomes a capture payload. The extension reads the
// values from the rendered page (apps/extension/src/read-page-metadata.ts), and the Worker reads
// them from the page's HTML for the address form (apps/worker/src/page-lookup.ts). Both turn
// them into the payload to validate here, so a page gives the same fields whichever way it was
// read. See "Captured payload from the extension" in plans/haystack-v1-implementation-plan.md.
import { CAPTURE_CAPS, type CaptureField } from "./capture-payload.ts";
import { truncate } from "./truncate.ts";

// The text fields of the payload and where each comes from in the page's metadata. Every cap is
// a field's own, so a new text field needs only a line here.
const TEXT_FIELDS = [
  ["title", "documentTitle"],
  ["description", "description"],
  ["og_title", "ogTitle"],
  ["og_description", "ogDescription"],
  ["og_site_name", "ogSiteName"],
] as const satisfies ReadonlyArray<readonly [CaptureField, string]>;

/** The values a page can give, by the names the readers use. */
export const PAGE_METADATA_KEYS = ["canonicalUrl", ...TEXT_FIELDS.map(([, key]) => key)] as const;

export type PageMetadataKey = (typeof PAGE_METADATA_KEYS)[number];

/**
 * What a page says about itself, as raw strings, untrimmed. An absent key means the page did not
 * give the value. The canonical URL is already resolved to an absolute URL.
 */
export type RawPageMetadata = Partial<Record<PageMetadataKey, string>>;

/**
 * The payload to validate for a page: its address, and each value it gives, cut to its cap. Text
 * is trimmed first, so that the cap counts what the schema keeps. The canonical URL is
 * serialized the way the page's own address is, and never cut, because a shortened URL can
 * point somewhere else. An over-cap one is therefore left for validation to reject.
 */
export function capturedFieldsFromPage(
  url: string,
  metadata: RawPageMetadata,
): Record<string, string> {
  const candidate: Record<string, string> = { url };
  if (metadata.canonicalUrl !== undefined) {
    candidate.canonical_url =
      URL.parse(metadata.canonicalUrl.trim())?.href ?? metadata.canonicalUrl;
  }
  for (const [field, key] of TEXT_FIELDS) {
    const text = metadata[key];
    if (text !== undefined) {
      candidate[field] = truncate(text.trim(), CAPTURE_CAPS[field]);
    }
  }
  return candidate;
}
