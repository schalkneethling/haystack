// The shared page layout. The security headers every answer carries are added by the Worker's
// entry point (security-headers.ts), so the answers built here set only their content type.
import { SAVED_LINKS_PATH } from "./bookmark-paths.ts";
import { html, type SafeHtml } from "./html.ts";

// Static assets in apps/web/public. The tokens come first, because the page's stylesheet uses
// them. The popup imports the same tokens file into its build.
const STYLESHEETS = ["/assets/tokens.css", "/assets/site.css"] as const;

/** The pages the header's navigation links to. */
type NavigationPage = "search" | "saved-links";

// The search page is the home page (#206).
const SEARCH_PATH = "/";

// In the order the header shows them.
const NAVIGATION: readonly { page: NavigationPage; href: string; label: string }[] = [
  { page: "search", href: SEARCH_PATH, label: "Search" },
  { page: "saved-links", href: SAVED_LINKS_PATH, label: "Saved links" },
];

// The header's Search link: the navigation's link to `/`. The wordmark links to `/` too, but it
// is outside the navigation, so it stays.
const SEARCH_LINK = `nav.site-nav > a[href="${SEARCH_PATH}"]`;

/**
 * The page without the header's Search link, for while the `search-enabled` flag is off (#235,
 * flags.ts), when `/` sends the user on to the saved links and a link named Search would only
 * lead there. The entry point applies it to every page it sends a signed-in user, so the pages
 * themselves don't each read the flag, and the link and its removal stay together here.
 */
export function withoutSearchLink(response: Response): Response {
  return new HTMLRewriter()
    .on(SEARCH_LINK, {
      element(link) {
        link.remove();
      },
    })
    .transform(response);
}

export interface PageOptions {
  /**
   * Whether the page is shown to a signed-in user. Their header adds the main navigation and a
   * Sign out button. Every other page shows the wordmark only.
   */
  readonly signedIn: boolean;
  /**
   * The search page, the saved links page and /held are wide, so their grids have room for
   * columns. Every other page is narrow.
   */
  readonly width?: "narrow" | "wide";
  /** The navigation link to mark as the current page. */
  readonly current?: NavigationPage;
  /**
   * Paths of module scripts served as static assets from apps/web/public. Each enhances a page
   * that already works without it, except the search page's, which searching needs, because the
   * results are built from JSON in the browser (search-page.ts).
   */
  readonly scripts?: readonly string[];
}

// Sign out is a form, because it is a POST with the Origin check, and works without JavaScript.
function siteActions(current: PageOptions["current"]): SafeHtml {
  // The first link follows `<nav>` on the same line, and each other one starts a line of its
  // own, so when withoutSearchLink takes out the first, Search, no line of only spaces is left.
  const links = NAVIGATION.map(({ page, href, label }, index) => {
    const link = html`<a class="nav-link" href="${href}"${page === current ? html` aria-current="page"` : null}>${label}</a>`;
    return index === 0
      ? link
      : html`
            ${link}`;
  });
  return html`
        <div class="site-actions">
          <nav class="site-nav" aria-label="Main">${links}
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
