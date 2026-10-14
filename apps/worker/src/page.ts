// The shared page layout and the headers every HTML response carries.
import { html, type SafeHtml } from "./html.ts";

// Each phase that adds a kind of resource widens this on purpose. Scripts come only from this
// origin's static assets (never inline), and may call only this origin (#43). form-action
// allows posting only to this origin, and frame-ancestors prevents framing.
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const HTML_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  // Not no-referrer: with it, browsers send `Origin: null` on same-origin form posts, which the
  // Origin check rejects (plan, "Rules that hold everywhere").
  "referrer-policy": "strict-origin-when-cross-origin",
};

function page(title: string, content: SafeHtml, scripts: readonly string[]): SafeHtml {
  return html`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} - Haystack</title>${scripts.map(
      (src) => html`
    <script type="module" src="${src}"></script>`,
    )}
  </head>
  <body>
    <main>${content}</main>
  </body>
</html>
`;
}

/**
 * An HTML page. `scripts` are paths of module scripts served as static assets from
 * apps/web/public; each enhances a page that already works without it.
 */
export function htmlResponse(
  title: string,
  content: SafeHtml,
  status: number,
  scripts: readonly string[] = [],
): Response {
  return new Response(page(title, content, scripts).toString(), { status, headers: HTML_HEADERS });
}
