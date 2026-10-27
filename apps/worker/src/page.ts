// The shared page layout. The security headers every answer carries are added by the Worker's
// entry point (security-headers.ts), so the answers built here set only their content type.
import { html, type SafeHtml } from "./html.ts";

// Static assets in apps/web/public. The tokens come first, because the page's stylesheet uses
// them. The popup imports the same tokens file into its build.
const STYLESHEETS = ["/assets/tokens.css", "/assets/site.css"] as const;

export interface PageOptions {
  /**
   * Whether the page is shown to a signed-in user. Their header adds the main navigation and a
   * Sign out button. Every other page shows the wordmark only.
   */
  readonly signedIn: boolean;
  /**
   * The saved links page and /held are wide, so their grids have room for columns. Every other
   * page is narrow.
   */
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

/** A page's whole title, as the browser shows it, from the page's own part of it. */
export function pageTitle(title: string): string {
  return `${title} - Haystack`;
}

function page(title: string, content: SafeHtml, options: PageOptions): SafeHtml {
  const bodyClass = options.width === "wide" ? html` class="layout-wide"` : null;
  return html`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${pageTitle(title)}</title>${STYLESHEETS.map(
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
  return new Response(page(title, content, options).toString(), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** A JSON answer to one of the site's own scripts. */
export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
