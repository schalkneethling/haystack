// The payload the extension puts into the /save query string. See "Captured payload from the
// extension" in plans/haystack-v1-implementation-plan.md. The extension truncates to these
// caps before validating; anything longer is rejected.
import * as v from "valibot";

export const CAPTURE_CAPS = {
  url: 2048,
  canonical_url: 2048,
  title: 200,
  description: 300,
  og_title: 200,
  og_description: 300,
  og_site_name: 100,
} as const;

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

const NOT_HTTP_URL = "Must be an http or https URL";

// Trimmed, capped, and absent when empty after trimming.
function optionalText(maxLength: number) {
  return v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(maxLength),
      v.transform((value) => (value === "" ? undefined : value)),
    ),
  );
}

export const CapturePayload = v.object({
  url: v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(CAPTURE_CAPS.url),
    v.check(isHttpUrl, NOT_HTTP_URL),
  ),
  canonical_url: v.pipe(
    optionalText(CAPTURE_CAPS.canonical_url),
    v.check((value) => value === undefined || isHttpUrl(value), NOT_HTTP_URL),
  ),
  title: optionalText(CAPTURE_CAPS.title),
  description: optionalText(CAPTURE_CAPS.description),
  og_title: optionalText(CAPTURE_CAPS.og_title),
  og_description: optionalText(CAPTURE_CAPS.og_description),
  og_site_name: optionalText(CAPTURE_CAPS.og_site_name),
});

export type CapturePayload = v.InferOutput<typeof CapturePayload>;
