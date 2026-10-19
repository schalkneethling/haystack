// Reading a page's title and description for the address form (#105). The Worker fetches the
// page only after a POST from the address form, and only for an address that has passed the
// checks, because opening a link can have side effects (see "Save flow" and "Untrusted content"
// in plans/haystack-v1-implementation-plan.md). Everything the page says is untrusted: this
// module only collects raw strings, and the caller cuts and validates them as it does the
// extension's.
//
// The limits:
// - The whole lookup, from the request to the last byte read, stops after LOOKUP_TIMEOUT_MS.
// - The request names Haystack and its address, and carries no cookie or credential. A Worker
//   keeps no cookies, and only the headers set here are sent.
// - Only a 2xx `text/html` response is read, and only its head: reading stops at `</head>`, at
//   `<body>`, or after LOOKUP_READ_LIMIT_BYTES, and the rest of the body is cancelled.
// - Redirects are followed with the Workers runtime's defaults, so the page is the one a browser
//   would open. The canonical link is resolved against the page's final address.
import type { RawPageMetadata } from "@haystack/schemas";
import { decodeHTML, decodeHTMLAttribute } from "entities/decode";

/** How long a lookup may take, from the request to the last byte read. */
export const LOOKUP_TIMEOUT_MS = 3000;

/**
 * How much of a page is read at most, in bytes after decompression. A page's title and meta tags
 * come early in its head, but a head that inlines its styles and scripts can run to hundreds of
 * kilobytes before them. 256 KiB covers such heads, while keeping the parsing work, which counts
 * towards the Workers Free plan's 10 ms of CPU time per request, small. Counting decompressed
 * bytes also stops a small compressed response that expands to a huge one.
 */
export const LOOKUP_READ_LIMIT_BYTES = 256 * 1024;

/** Why a lookup gave nothing, as a fixed code that is safe to log. */
export type LookupFailure = "timeout" | "network" | "status" | "not-html" | "unreadable";

export type PageLookup =
  | { readonly ok: true; readonly metadata: RawPageMetadata }
  | { readonly ok: false; readonly reason: LookupFailure };

/** The User-Agent the lookup sends: Haystack, and the address of the Haystack that asks. */
export function lookupUserAgent(origin: string): string {
  return `Haystack (+${origin})`;
}

// `content-type` without its parameters, in lower case, as the MIME type's essence.
function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

// HTML attribute values are compared ASCII case-insensitively, as the extension's `i` selectors
// do. toLowerCase would also fold characters outside ASCII.
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

const ASCII_WHITESPACE = /[\t\n\f\r ]+/g;

/**
 * Collects what the page's head says about itself, by the rules the extension's
 * readPageMetadata follows, so a page gives the same values either way: a value that is empty or
 * only whitespace counts as absent, the first tag with content wins, and each Open Graph tag is
 * read from `property` or `name`. HTMLRewriter hands over text and attribute values as written,
 * with character references such as `&amp;` left in, so they are decoded here, as a browser
 * decodes them. The title is decoded, then its whitespace is collapsed and trimmed, as
 * `document.title` does.
 *
 * The extension reads the whole rendered document, and this reads only the head. A tag after
 * `<body>`, or one that a script adds, is therefore not read here.
 */
class HeadReader {
  /**
   * Whether the head has ended, so nothing more is read. The rewriter goes on through the rest of
   * the chunk it is parsing, so every handler checks this first.
   */
  finished = false;
  #title: string | undefined;
  #inTitle = false;
  #base: string | undefined;
  readonly #canonicalHrefs: string[] = [];
  readonly #meta: Partial<
    Record<"description" | "ogTitle" | "ogDescription" | "ogSiteName", string>
  > = {};

  rewriter(): HTMLRewriter {
    return new HTMLRewriter()
      .on("head", {
        element: (element) => {
          element.onEndTag(() => {
            this.finished = true;
          });
        },
      })
      .on("body", {
        element: () => {
          this.finished = true;
        },
      })
      .on("title", {
        element: (element) => {
          // Only the first title counts, as for document.title.
          if (this.finished || this.#title !== undefined) {
            return;
          }
          this.#title = "";
          this.#inTitle = true;
          element.onEndTag(() => {
            this.#inTitle = false;
          });
        },
        text: (text) => {
          if (this.#inTitle) {
            this.#title += text.text;
          }
        },
      })
      .on("meta", { element: (element) => this.#readMeta(element) })
      .on("link", { element: (element) => this.#readLink(element) })
      .on("base", {
        element: (element) => {
          // The first base element with an href sets the document's base URL.
          const href = element.getAttribute("href");
          if (!this.finished && this.#base === undefined && href !== null) {
            this.#base = decodeHTMLAttribute(href);
          }
        },
      });
  }

  #readMeta(element: Element): void {
    if (this.finished) {
      return;
    }
    const value = decodeHTMLAttribute(element.getAttribute("content") ?? "");
    if (value.trim() === "") {
      return;
    }
    const name = asciiLowerCase(decodeHTMLAttribute(element.getAttribute("name") ?? ""));
    const property = asciiLowerCase(decodeHTMLAttribute(element.getAttribute("property") ?? ""));
    const names = new Set([name, property]);
    // The description is read from `name` only, as the extension reads it.
    if (name === "description") {
      this.#meta.description ??= value;
    }
    if (names.has("og:title")) {
      this.#meta.ogTitle ??= value;
    }
    if (names.has("og:description")) {
      this.#meta.ogDescription ??= value;
    }
    if (names.has("og:site_name")) {
      this.#meta.ogSiteName ??= value;
    }
  }

  #readLink(element: Element): void {
    if (this.finished) {
      return;
    }
    const href = element.getAttribute("href");
    const rel = element.getAttribute("rel");
    if (href === null || rel === null) {
      return;
    }
    const tokens = asciiLowerCase(decodeHTMLAttribute(rel)).split(ASCII_WHITESPACE);
    if (tokens.includes("canonical")) {
      this.#canonicalHrefs.push(decodeHTMLAttribute(href));
    }
  }

  /** What was read, with the canonical link resolved against the document's base URL. */
  metadata(pageUrl: string): RawPageMetadata {
    // The first base href, resolved against the page's address, or the address itself when the
    // page has none or it does not parse, as a browser takes it.
    const base =
      (this.#base === undefined ? undefined : URL.parse(this.#base, pageUrl)?.href) ?? pageUrl;
    const metadata: RawPageMetadata = { ...this.#meta };
    if (this.#title !== undefined) {
      metadata.documentTitle = decodeHTML(this.#title).replace(ASCII_WHITESPACE, " ").trim();
    }
    // A blank href would resolve to the page itself, and one that does not parse is skipped.
    for (const href of this.#canonicalHrefs) {
      const resolved = href.trim() === "" ? null : URL.parse(href, base);
      if (resolved !== null) {
        metadata.canonicalUrl = resolved.href;
        break;
      }
    }
    return metadata;
  }
}

// Feeds the body to the reader until the head ends or the byte limit is reached, then cancels
// the rest of the body, so a large page is never downloaded in full.
async function readHead(
  response: Response,
  body: ReadableStream<Uint8Array>,
): Promise<RawPageMetadata> {
  const reader = new HeadReader();
  const source = body.getReader();
  let bytes = 0;
  const limited = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (reader.finished || bytes >= LOOKUP_READ_LIMIT_BYTES) {
        controller.close();
        await source.cancel();
        return;
      }
      const chunk = await source.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      const room = LOOKUP_READ_LIMIT_BYTES - bytes;
      const value = chunk.value.byteLength > room ? chunk.value.subarray(0, room) : chunk.value;
      bytes += value.byteLength;
      controller.enqueue(value);
    },
    cancel(reason) {
      return source.cancel(reason);
    },
  });
  // Only the content type goes with the body, for its charset. The body is already decompressed.
  const rewritten = reader.rewriter().transform(
    new Response(limited, {
      headers: { "content-type": response.headers.get("content-type") ?? "" },
    }),
  );
  // The rewriter parses as its output is read. The output itself is not needed.
  const output = rewritten.body?.getReader();
  while (output !== undefined && !(await output.read()).done) {
    // Keep reading.
  }
  // After redirects, response.url is the page's final address.
  return reader.metadata(response.url);
}

function discard(response: Response): void {
  response.body?.cancel().catch(() => {
    // Nothing more is wanted from this response.
  });
}

/** Fetches a page and reads what its head says about itself, within the limits above. */
export async function lookUpPage(url: string, origin: string): Promise<PageLookup> {
  const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      // Only these headers are sent: no cookie, no authorization, nothing from the user's request.
      headers: { "user-agent": lookupUserAgent(origin), accept: "text/html" },
      redirect: "follow",
      signal,
    });
  } catch {
    return { ok: false, reason: signal.aborted ? "timeout" : "network" };
  }
  if (!response.ok) {
    discard(response);
    return { ok: false, reason: "status" };
  }
  if (mediaType(response) !== "text/html" || response.body === null) {
    discard(response);
    return { ok: false, reason: "not-html" };
  }
  try {
    return { ok: true, metadata: await readHead(response, response.body) };
  } catch {
    discard(response);
    return { ok: false, reason: signal.aborted ? "timeout" : "unreadable" };
  }
}
