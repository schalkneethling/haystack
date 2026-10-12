// Where to send the user after sign-in. See "Return targets" in
// plans/haystack-v1-implementation-plan.md: only a path on this origin, so sign-in cannot
// become an open redirect.

const PLACEHOLDER_ORIGIN = "https://haystack.invalid";

/**
 * Returns the target as a path, query, and fragment on this origin, or `/` when it would leave
 * the origin. Resolving against a placeholder origin catches every form a browser would treat
 * as another host: `//host`, `/\host`, and `/<tab>/host` (the URL parser removes tabs and
 * newlines), as well as absolute URLs.
 */
export function safeReturnTarget(value: string | null): string {
  if (value === null || !value.startsWith("/")) {
    return "/";
  }
  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return "/";
  }
  // Dot segments collapse during parsing, so `/.//host` resolves to the path `//host`, which a
  // browser would read as another host. The result must also be safe when parsed again.
  if (url.origin !== PLACEHOLDER_ORIGIN || url.pathname.startsWith("//")) {
    return "/";
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
