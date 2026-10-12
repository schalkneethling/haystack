// The shared page layout and the headers every HTML response carries.
import { html, type SafeHtml } from "./html.ts";

// No scripts, styles, or other resources yet; each phase that adds one widens this on purpose.
// form-action allows posting only to this origin, and frame-ancestors prevents framing.
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export const HTML_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  // Not no-referrer: with it, browsers send `Origin: null` on same-origin form posts, which the
  // Origin check rejects (plan, "Rules that hold everywhere").
  "referrer-policy": "strict-origin-when-cross-origin",
};

export function page(title: string, content: SafeHtml): SafeHtml {
  return html`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} - Haystack</title>
  </head>
  <body>
    <main>${content}</main>
  </body>
</html>
`;
}

export function htmlResponse(
  title: string,
  content: SafeHtml,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(page(title, content).toString(), {
    status,
    headers: { ...HTML_HEADERS, ...headers },
  });
}
