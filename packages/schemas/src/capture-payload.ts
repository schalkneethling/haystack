// The payload the extension puts into the /save query string. See "Captured payload from the
// extension" in plans/haystack-v1-implementation-plan.md. Unknown keys are dropped.
import * as v from "valibot";

// Caps in UTF-16 code units (String.prototype.length), so an emoji counts as 2. The extension
// truncates to these caps without splitting a surrogate pair, then validates; anything longer
// is rejected. The caps alone do not keep the save URL under Cloudflare's 16 KB limit: the
// save link is also kept within SAVE_URL_BUDGET (save-url.ts).
export const CAPTURE_CAPS = {
  url: 2048,
  canonical_url: 2048,
  title: 200,
  description: 300,
  og_title: 200,
  og_description: 300,
  og_site_name: 100,
} as const;

/**
 * The query key of the flag that says the page declared a canonical URL that `detectSensitiveUrl`
 * flags, and that the URL was dropped (#131). It is the column's name. It is not a captured
 * field: it has no cap and never holds a value from the page, so it is not in CAPTURE_CAPS. It
 * is in the payload, so that it travels with the fields in the save link, in the form's hidden
 * inputs and through the signed-out return target.
 */
export const SENSITIVE_CANONICAL_DROPPED = "sensitive_canonical_dropped";

/** The only value of the flag that counts as set. Any other value is read as not set. */
const FLAG_SET = "1";

// The URL parser silently strips leading control characters, removes tab, CR, and LF
// anywhere, trims trailing spaces, and percent-encodes inner ones. The stored URL is the
// submitted string, so it must already be what the parser reads: no C0 control characters,
// spaces, or DEL, and an explicit scheme prefix (`https:example.com` parses, but as a link it
// resolves against the page's own origin). Browsers serialize URLs with
// spaces encoded, so only hand-built links are affected.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const CHARACTERS_THE_PARSER_CHANGES = /[\u0000-\u0020\u007f]/;
const HTTP_PREFIX = /^https?:\/\//i;
const HTTPS_PREFIX = /^https:\/\//i;

function parsesAsWritten(value: string, prefix: RegExp): boolean {
  return !CHARACTERS_THE_PARSER_CHANGES.test(value) && prefix.test(value) && URL.canParse(value);
}

/**
 * Whether a value is an https URL exactly as the URL parser reads it: an explicit `https://`
 * prefix, and no spaces or control characters. Haystack saves only https pages, so every saved
 * address can be a link (decided 2026-10-13, #40), and pages link only to addresses that pass.
 * The canonical URL is only enrichment evidence and is never linked, so an http one does not
 * stop a page from being saved.
 */
export function isHttpsUrl(value: string): boolean {
  return parsesAsWritten(value, HTTPS_PREFIX);
}

function isHttpOrHttpsUrl(value: string): boolean {
  return parsesAsWritten(value, HTTP_PREFIX);
}

// A lone surrogate makes encodeURIComponent throw, so the save URL could not be built.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function isWellFormed(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

const NOT_HTTPS_URL = "Must be an https URL";
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

// The flag is a hint, so a value other than "1" is not an error: it is read as not set, and
// `omitUndefined` leaves it out of the payload. `unknown` keeps even a non-string from failing.
const canonicalDroppedFlag = v.optional(
  v.pipe(
    v.unknown(),
    v.transform((value): typeof FLAG_SET | undefined =>
      value === FLAG_SET ? FLAG_SET : undefined,
    ),
  ),
);

export const CapturePayload = v.pipe(
  v.object({
    url: v.pipe(
      v.string(),
      v.trim(),
      v.check(isWellFormed, NOT_WELL_FORMED),
      v.maxLength(CAPTURE_CAPS.url),
      v.check(isHttpsUrl, NOT_HTTPS_URL),
    ),
    canonical_url: v.pipe(
      optionalText(CAPTURE_CAPS.canonical_url),
      v.check((value) => value === undefined || isHttpOrHttpsUrl(value), NOT_HTTP_URL),
    ),
    title: optionalText(CAPTURE_CAPS.title),
    description: optionalText(CAPTURE_CAPS.description),
    og_title: optionalText(CAPTURE_CAPS.og_title),
    og_description: optionalText(CAPTURE_CAPS.og_description),
    og_site_name: optionalText(CAPTURE_CAPS.og_site_name),
    // Last, so that a save link lists it after the fields, as the popup builds it.
    [SENSITIVE_CANONICAL_DROPPED]: canonicalDroppedFlag,
  }),
  v.transform(omitUndefined),
);

export type CapturePayload = v.InferOutput<typeof CapturePayload>;

// Every field has a cap, and every cap has a field. The flag is the payload's only key without one.
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
true satisfies SameKeys<
  typeof CAPTURE_CAPS,
  Omit<v.InferInput<typeof CapturePayload>, typeof SENSITIVE_CANONICAL_DROPPED>
>;

export type CaptureField = keyof typeof CAPTURE_CAPS;

/**
 * Every query key `/save` reads: the captured fields and the flag. A link, a form submission and
 * a return target keep the flag by reading and writing it with the fields.
 */
export const CAPTURE_KEYS: readonly string[] = [
  ...Object.keys(CAPTURE_CAPS),
  SENSITIVE_CANONICAL_DROPPED,
];

/**
 * Whether the payload says that the page declared a canonical URL that `detectSensitiveUrl`
 * flags (#131). Readers use this and do not compare the value themselves. The flag comes from
 * the client, so it is evidence and not proof.
 */
export function declaredSensitiveCanonical(payload: CapturePayload): boolean {
  return payload[SENSITIVE_CANONICAL_DROPPED] === FLAG_SET;
}

export type CaptureValidation =
  | { ok: true; payload: CapturePayload }
  | { ok: false; invalidFields: CaptureField[] };

/**
 * Validates a payload and names the invalid fields, never their values, so a page can explain
 * the problem without echoing captured data.
 */
export function validateCapturePayload(input: unknown): CaptureValidation {
  const result = v.safeParse(CapturePayload, input);
  if (result.success) {
    return { ok: true, payload: result.output };
  }
  const fields = new Set<CaptureField>();
  for (const issue of result.issues) {
    const key = issue.path?.[0]?.key;
    if (typeof key === "string" && key in CAPTURE_CAPS) {
      fields.add(key as CaptureField);
    }
  }
  return { ok: false, invalidFields: [...fields] };
}
