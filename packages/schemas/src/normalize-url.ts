// normalized_url is stored and used only for duplicate detection. See "URL normalization" in
// plans/haystack-v1-implementation-plan.md: changing these rules makes stored rows out of date,
// so a change needs a migration that recomputes the column and resolves collisions.

// Tracking parameters, matched case-insensitively. Every `utm_*` key is also removed.
export const TRACKING_PARAMETERS: readonly string[] = Object.freeze([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
]);

const trackingParameters = new Set(TRACKING_PARAMETERS);

// Keys as a server reads them: `+` is a space, and percent-escapes are decoded.
function decodeKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replaceAll("+", " "));
  } catch {
    return rawKey;
  }
}

// Each pair stays as the URL parser serialized it, so percent-encoding is not normalized.
// Sorting compares decoded keys, so pairs whose keys decode to the same name keep their order.
function normalizeQuery(search: string): string {
  const pairs = search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => ({ pair, key: decodeKey(pair.split("=", 1)[0] ?? "") }))
    .filter(({ key }) => {
      const lowerKey = key.toLowerCase();
      return !lowerKey.startsWith("utm_") && !trackingParameters.has(lowerKey);
    });
  // Array.prototype.sort is stable, so repeated keys keep their order.
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return pairs.length === 0 ? "" : `?${pairs.map(({ pair }) => pair).join("&")}`;
}

/**
 * Normalizes an http or https URL for duplicate detection. The WHATWG URL parser lowercases
 * the scheme and host and removes default ports. This function also removes the fragment,
 * credentials, tracking parameters, and one trailing slash from the path, and sorts the query
 * parameters by key.
 *
 * Pass the URL as submitted, never a stored normalized value: the function is not idempotent
 * for paths ending in more than one slash (`/docs//` gives `/docs/`, which gives `/docs`).
 * Throws a TypeError if the input is not a valid http or https URL.
 */
export function normalizeUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("normalizeUrl only accepts http and https URLs");
  }
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.origin}${path}${normalizeQuery(url.search)}`;
}
