// The payload the extension puts into the /save query string. See "Captured payload from the
// extension" in plans/haystack-v1-implementation-plan.md. Unknown keys are dropped.
import * as v from "valibot";

// Caps in UTF-16 code units (String.prototype.length), so an emoji counts as 2. The extension
// truncates to these caps without splitting a surrogate pair, then validates; anything longer
// is rejected. The caps alone do not keep the save URL under Cloudflare's 16 KB limit: the
// extension also checks the encoded length (see the plan).
export const CAPTURE_CAPS = {
  url: 2048,
  canonical_url: 2048,
  title: 200,
  description: 300,
  og_title: 200,
  og_description: 300,
  og_site_name: 100,
} as const;

// The URL parser silently strips leading control characters, removes tab, CR, and LF
// anywhere, trims trailing spaces, and percent-encodes inner ones. The stored URL is the
// submitted string, so it must already be what the parser reads: no C0 control characters,
// spaces, or DEL, and an explicit `http://` or `https://` prefix (`https:example.com` parses,
// but as a link it resolves against the page's own origin). Browsers serialize URLs with
// spaces encoded, so only hand-built links are affected.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const CHARACTERS_THE_PARSER_CHANGES = /[\u0000-\u0020\u007f]/;
const HTTP_PREFIX = /^https?:\/\//i;

function isHttpUrl(value: string): boolean {
  if (CHARACTERS_THE_PARSER_CHANGES.test(value) || !HTTP_PREFIX.test(value)) {
    return false;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// A lone surrogate makes encodeURIComponent throw, so the save URL could not be built.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function isWellFormed(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

const NOT_HTTP_URL = "Must be an http or https URL";
const NOT_WELL_FORMED = "Must not contain a lone surrogate";

// Trimmed, well formed, and capped. Empty after trimming means absent.
function optionalText(maxLength: number) {
  return v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.check(isWellFormed, NOT_WELL_FORMED),
      v.maxLength(maxLength),
      v.transform((value) => (value === "" ? undefined : value)),
    ),
  );
}

// Removes keys whose value is undefined, so an absent field is a missing key, not a key set
// to undefined (which would overwrite a fallback in an object spread).
function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export const CapturePayload = v.pipe(
  v.object({
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
  }),
  v.transform(omitUndefined),
);

export type CapturePayload = v.InferOutput<typeof CapturePayload>;

// Every field has a cap, and every cap has a field.
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
true satisfies SameKeys<typeof CAPTURE_CAPS, v.InferInput<typeof CapturePayload>>;
