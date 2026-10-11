// normalized_url is stored and used only for duplicate detection. See "URL normalization" in
// plans/haystack-v1-implementation-plan.md: changing these rules makes stored rows out of date,
// so a change needs a migration that recomputes the column and resolves collisions.

// Tracking parameters, matched case-insensitively. Every `utm_*` key is also removed.
export const TRACKING_PARAMETERS: ReadonlySet<string> = new Set([
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

function decodeKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replaceAll("+", " "));
  } catch {
    return rawKey;
  }
}

function isTrackingParameter(rawKey: string): boolean {
  const key = decodeKey(rawKey).toLowerCase();
  return key.startsWith("utm_") || TRACKING_PARAMETERS.has(key);
}

// Each `key=value` pair stays exactly as written, so percent-encoding is not normalized.
function normalizeQuery(search: string): string {
  const pairs = search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => ({ pair, key: pair.split("=", 1)[0] ?? "" }))
    .filter(({ key }) => !isTrackingParameter(key));
  // Array.prototype.sort is stable, so repeated keys keep their order.
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return pairs.length === 0 ? "" : `?${pairs.map(({ pair }) => pair).join("&")}`;
}

/**
 * Normalizes an http or https URL for duplicate detection. The WHATWG URL parser lowercases
 * the scheme and host and removes default ports. This function also removes the fragment,
 * credentials, tracking parameters, and one trailing slash from the path, and sorts the query
 * parameters by key. Throws a TypeError if the input is not a valid URL.
 */
export function normalizeUrl(input: string): string {
  const url = new URL(input);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.origin}${path}${normalizeQuery(url.search)}`;
}
