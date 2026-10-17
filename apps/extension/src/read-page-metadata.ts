// The function the popup injects into the active tab to read the page's metadata. See
// "Captured payload from the extension" in plans/haystack-v1-implementation-plan.md.

/**
 * What the page says about itself, as raw strings. Nothing is trimmed, truncated or validated
 * here, because the page is untrusted and the popup checks every value (open-save-form.ts).
 * It holds only strings and nulls, so it survives the structured clone back to the popup.
 */
export interface PageMetadata {
  /** The canonical link, resolved to an absolute URL. */
  canonicalUrl: string | null;
  description: string | null;
  documentTitle: string;
  ogTitle: string | null;
  ogDescription: string | null;
  ogSiteName: string | null;
}

/**
 * Reads the metadata from the document it runs in.
 *
 * `scripting.executeScript` serializes this function's source and runs it in the page, so it
 * must not use anything from this module or from the popup, not even a constant or a helper.
 * Its helpers are declared inside it for that reason.
 *
 * A value that is empty or only whitespace counts as absent, so a blank tag cannot hide a later
 * tag that has content. When a tag appears more than once, the first one with content wins. The
 * Open Graph protocol says that "the first tag (from top to bottom) is given preference during
 * conflicts" (https://ogp.me/#array), but only about tags that repeat to make a list, such as
 * `og:image`. Taking the first `og:title` applies the rule to a tag the protocol does not cover.
 *
 * The protocol specifies `property` for the Open Graph tags, but pages often write `name`
 * instead, so both are read. One selector list matches both, and `querySelectorAll` returns the
 * matches in document order, so the first-with-content rule holds across the two attributes.
 */
export function readPageMetadata(): PageMetadata {
  const metaContent = (selector: string): string | null => {
    for (const element of document.querySelectorAll(selector)) {
      const content = element.getAttribute("content");
      if (content !== null && content.trim() !== "") {
        return content;
      }
    }
    return null;
  };

  // The `href` attribute is resolved against the document's base URL, which a `<base>` element
  // can change, the way a link would be. A blank value is skipped, because an empty one would
  // resolve to the page itself, and so is one that does not parse.
  const canonicalUrl = (): string | null => {
    for (const link of document.querySelectorAll('link[rel~="canonical" i][href]')) {
      const href = link.getAttribute("href") ?? "";
      const resolved = href.trim() === "" ? null : URL.parse(href, document.baseURI);
      if (resolved !== null) {
        return resolved.href;
      }
    }
    return null;
  };

  const openGraph = (name: string): string | null =>
    metaContent(`meta[property="${name}" i], meta[name="${name}" i]`);

  return {
    canonicalUrl: canonicalUrl(),
    description: metaContent('meta[name="description" i]'),
    documentTitle: document.title,
    ogTitle: openGraph("og:title"),
    ogDescription: openGraph("og:description"),
    ogSiteName: openGraph("og:site_name"),
  };
}
