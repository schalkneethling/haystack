// The shared page layout and the headers every HTML response carries.
import { html, type SafeHtml } from "./html.ts";

// Each phase that adds a kind of resource widens this on purpose. Scripts, stylesheets and fonts
// come only from this origin's static assets, never inline, and scripts may call only this
// origin (#43). Without 'unsafe-inline', no page can carry a style attribute or a <style>
// block. form-action allows posting only to this origin, and frame-ancestors prevents framing.
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const HTML_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  // Not no-referrer: with it, browsers send `Origin: null` on same-origin form posts, which the
  // Origin check rejects (plan, "Rules that hold everywhere").
  "referrer-policy": "strict-origin-when-cross-origin",
};

// Static assets in apps/web/public. The tokens come first, because the page's stylesheet uses
// them. The popup imports the same tokens file into its build.
const STYLESHEETS = ["/assets/tokens.css", "/assets/site.css"] as const;

export interface PageOptions {
  /**
   * Whether the page is shown to a signed-in user. Their header adds the main navigation and a
   * Sign out button. Every other page shows the wordmark only.
   */
  readonly signedIn: boolean;
  /** The saved links page is wide, so its grid has room for columns. Every other page is narrow. */
  readonly width?: "narrow" | "wide";
  /** The navigation link to mark as the current page. */
  readonly current?: "saved-links";
  /**
   * Paths of module scripts served as static assets from apps/web/public. Each enhances a page
   * that already works without it.
   */
  readonly scripts?: readonly string[];
}

// Sign out is a form, because it is a POST with the Origin check, and works without JavaScript.
function siteActions(current: PageOptions["current"]): SafeHtml {
  const currentPage = current === "saved-links" ? html` aria-current="page"` : null;
  return html`
        <div class="site-actions">
          <nav class="site-nav" aria-label="Main">
            <a class="nav-link" href="/"${currentPage}>Saved links</a>
          </nav>
          <form method="post" action="/auth/sign-out">
            <button class="button button-small" type="submit">Sign out</button>
          </form>
        </div>`;
}

function siteHeader({ signedIn, current }: PageOptions): SafeHtml {
  return html`<header>
      <div class="site-header-inner">
        <a class="wordmark" href="/"><span class="wordmark-dot" aria-hidden="true"></span>Haystack</a>${signedIn ? siteActions(current) : null}
      </div>
    </header>`;
}

function page(title: string, content: SafeHtml, options: PageOptions): SafeHtml {
  const bodyClass = options.width === "wide" ? html` class="layout-wide"` : null;
  return html`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} - Haystack</title>${STYLESHEETS.map(
      (href) => html`
    <link rel="stylesheet" href="${href}">`,
    )}${(options.scripts ?? []).map(
      (src) => html`
    <script type="module" src="${src}"></script>`,
    )}
  </head>
  <body${bodyClass}>
    ${siteHeader(options)}
    <main>${content}</main>
  </body>
</html>
`;
}

/** An HTML page in the shared layout. */
export function htmlResponse(
  title: string,
  content: SafeHtml,
  status: number,
  options: PageOptions,
): Response {
  return new Response(page(title, content, options).toString(), { status, headers: HTML_HEADERS });
}

// The headers of a JSON answer to the site's own script: the HTML pages' security headers, and
// no-store, because each answer belongs to one user and one request, and must not be reused.
const JSON_HEADERS: Readonly<Record<string, string>> = {
  ...HTML_HEADERS,
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/** A JSON answer to one of the site's own scripts. */
export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
