// The security headers on every answer the Worker builds (#113). See "Untrusted content" in
// plans/haystack-v1-implementation-plan.md, which lists the headers each kind of answer carries.
//
// The Worker's entry point passes every answer through `withSecurityHeaders`, so no route can
// send one without them, and the code that builds an answer sets only its content type. Static
// assets never reach the Worker; apps/web/public/_headers gives them `nosniff`.

// Each phase that adds a kind of resource widens this on purpose. Scripts, stylesheets and fonts
// come only from this origin's static assets, never inline, and scripts may call only this
// origin (#43). Without 'unsafe-inline', no page can carry a style attribute or a <style>
// block. form-action allows posting only to this origin, and frame-ancestors prevents framing.
const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// A JSON or plain-text answer that a browser opens as a document loads nothing and is never
// framed.
const BODY_POLICY = "default-src 'none'; frame-ancestors 'none'";

// Every answer is built for one request, and most hold a user's data or a return target with a
// save link in it, so no cache keeps any of them, the browser's own included. A signed-in page
// with `private, no-cache` could still be kept by the browser and shown again from its history
// after Sign out (plan, "Untrusted content").
const NO_STORE = "no-store";

// Not no-referrer: with it, browsers send `Origin: null` on same-origin form posts, which the
// Origin check rejects (plan, "Rules that hold everywhere").
const REFERRER_POLICY = "strict-origin-when-cross-origin";

/** The kinds of answer, which differ in the headers that have an effect on them. */
export type AnswerKind = "page" | "body" | "redirect";

/**
 * The security headers for each kind of answer, and only those that act on it:
 *
 * - A page gets its CSP, `nosniff`, the referrer policy for its links and forms, and no-store.
 * - A JSON or plain-text body gets a CSP that allows nothing, `nosniff`, so a browser never reads
 *   it as HTML, and no-store. It has no links or forms, so no referrer policy.
 * - A redirect has no body, so no CSP or `nosniff`. A Referrer-Policy on it replaces the policy
 *   of the request that follows it (Referrer Policy, "Set request's referrer policy on
 *   redirect"), and no-store keeps its Location, which can hold a save link, out of caches.
 */
export const SECURITY_HEADERS: Readonly<Record<AnswerKind, Readonly<Record<string, string>>>> = {
  page: {
    "content-security-policy": PAGE_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": REFERRER_POLICY,
    "cache-control": NO_STORE,
  },
  body: {
    "content-security-policy": BODY_POLICY,
    "x-content-type-options": "nosniff",
    "cache-control": NO_STORE,
  },
  redirect: {
    "referrer-policy": REFERRER_POLICY,
    "cache-control": NO_STORE,
  },
};

/**
 * Which kind of answer a response is: a redirect by its status, a page by its HTML content type,
 * and a body otherwise. The entry point also uses it to find the pages whose header it changes.
 */
export function kindOf(response: Response): AnswerKind {
  if (response.status >= 300 && response.status < 400) {
    return "redirect";
  }
  const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim();
  return mediaType?.toLowerCase() === "text/html" ? "page" : "body";
}

/**
 * The answer with the security headers for its kind. They replace any the route set, so a route
 * cannot weaken them. The answer is copied first, because a response from fetch() or
 * Response.redirect() has immutable headers.
 */
export function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS[kindOf(secured)])) {
    secured.headers.set(name, value);
  }
  return secured;
}
