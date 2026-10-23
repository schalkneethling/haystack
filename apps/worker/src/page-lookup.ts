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
//   `<body>`, after LOOKUP_READ_LIMIT_BYTES, or after LOOKUP_ELEMENT_BUDGET elements, and the rest
//   of the body is cancelled.
// - Redirects are followed with the Workers runtime's defaults, so the page is the one a browser
//   would open. The canonical link is resolved against the page's final address.
import type { RawPageMetadata } from "@haystack/schemas";
import { decodeHTML, decodeHTMLAttribute } from "entities/decode";

/** How long a lookup may take, from the request to the last byte read. */
export const LOOKUP_TIMEOUT_MS = 3000;

/**
 * How much of a page is read at most, in bytes after decompression. A page's title and meta tags
 * come early in its head, but a head that inlines its styles and scripts can run to hundreds of
 * kilobytes before them, and 256 KiB covers such heads. Counting decompressed bytes also stops a
 * small compressed response that expands to a huge one. The byte limit does not bound the CPU
 * time on its own: LOOKUP_ELEMENT_BUDGET does that.
 */
export const LOOKUP_READ_LIMIT_BYTES = 256 * 1024;

/**
 * How many handler calls the reader takes at most. Every call counts: an element of any of the
 * selectors, `<head>`, `<title>`, and each chunk of a title's text. The Workers Free plan allows 10 ms of
 * CPU time per request, and each element that reaches a handler in JavaScript costs about 14 µs
 * in the local runtime (the review of #105 measured it: 256 KiB of repeated `<meta>` took about
 * 667 ms when every one reached JavaScript, and the same size of comments 11 ms). The selectors
 * below already keep every other element in the rewriter, which is fast, so only the tags the
 * reader wants reach JavaScript, and an ordinary page has a handful of them. 100 handled elements
 * is about 1.4 ms, which leaves room for the parsing and the rest of the request, and for a page
 * that repeats its tags many times over. A page that reaches the budget is read no further, and
 * what was read before it is kept, as the byte limit keeps what it read.
 */
export const LOOKUP_ELEMENT_BUDGET = 100;

/** Why a lookup gave nothing, as a fixed code that is safe to log. */
export type LookupFailure =
  | "timeout"
  | "network"
  | "status"
  | "not-html"
  | "charset"
  | "unreadable";

export type PageLookup =
  | { readonly ok: true; readonly metadata: RawPageMetadata }
  | { readonly ok: false; readonly reason: LookupFailure };

/** The User-Agent the lookup sends: Haystack, and the address of the Haystack that asks. */
export function lookupUserAgent(origin: string): string {
  return `Haystack (+${origin})`;
}

// `content-type` without its parameters, in lower case, as the MIME type's essence.
function mediaType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

// The `charset` parameter of a content type, or a `<meta http-equiv>` content, if it has one.
function charsetIn(value: string): string | undefined {
  return /charset\s*=\s*["']?([^"';\s]+)/i.exec(value)?.[1];
}

// HTML attribute values are compared ASCII case-insensitively, as the extension's `i` selectors
// do. toLowerCase would also fold characters outside ASCII.
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

const ASCII_WHITESPACE = /[\t\n\f\r ]+/g;
const EDGE_WHITESPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

// The message of the error the reader throws to stop the rewriter (see `HeadReader`).
const READER_DONE = "The page reader is done";

// The labels of UTF-8 in the WHATWG Encoding Standard, and of UTF-16, which the HTML standard
// reads as UTF-8 when a page declares it in a meta tag. Any other declared encoding would be read
// wrongly, because HTMLRewriter decodes by the response's header alone (see `HeadReader`).
const UTF8_LABELS: ReadonlySet<string> = new Set([
  "unicode-1-1-utf-8",
  "unicode11utf8",
  "unicode20utf8",
  "utf-8",
  "utf8",
  "x-unicode20utf8",
  "csunicode",
  "iso-10646-ucs-2",
  "ucs-2",
  "unicode",
  "unicodefeff",
  "unicodefffe",
  "utf-16",
  "utf-16be",
  "utf-16le",
]);

type MetaField = "description" | "ogTitle" | "ogDescription" | "ogSiteName";

// Each field's selectors. The description is read from `name` only, and each Open Graph tag from
// `property` or `name`, as the extension's readPageMetadata reads them. The `i` flag compares the
// value ASCII case-insensitively, as the extension's selectors do.
const META_SELECTORS: ReadonlyArray<readonly [MetaField, string]> = [
  ["description", 'meta[name="description" i][content]'],
  ...(
    [
      ["ogTitle", "og:title"],
      ["ogDescription", "og:description"],
      ["ogSiteName", "og:site_name"],
    ] as const
  ).flatMap(([field, name]) => [
    [field, `meta[property="${name}" i][content]`] as const,
    [field, `meta[name="${name}" i][content]`] as const,
  ]),
];

/**
 * Collects what the page's head says about itself, by the rules the extension's
 * readPageMetadata follows, so a page gives the same values either way: a value that is empty or
 * only whitespace counts as absent, the first tag with content wins, and each Open Graph tag is
 * read from `property` or `name`. HTMLRewriter hands over text and attribute values as written,
 * with character references such as `&amp;` left in, so they are decoded here, as a browser
 * decodes them. The title is decoded, then its whitespace is collapsed and trimmed, as
 * `document.title` does.
 *
 * Only the elements the reader wants reach its handlers, through the selectors, and every handler
 * call counts against LOOKUP_ELEMENT_BUDGET, so a page cannot make it spend its CPU time. When the
 * reader is done, for any reason, it stops the rewriter outright by throwing from the handler:
 * otherwise the rewriter would go on through the rest of the chunk it is parsing, and call a
 * handler for every matching element in it. In workerd, a handler that throws stops the rewriter
 * from calling any further handler, and the error comes out of the rewritten body, without its
 * class, so `readHead` tells the stop apart by the reader's `finished` flag.
 *
 * HTMLRewriter decodes the page by the charset in the response's `content-type`, or as UTF-8, and
 * not by a `<meta charset>` in the page. So when the header names no charset and the head
 * declares one other than UTF-8, the reader stops and the lookup gives nothing, rather than
 * garbled text.
 *
 * The extension reads the whole rendered document, and this reads only the head. A tag after
 * `<body>`, or one that a script adds, is therefore not read here.
 */
class HeadReader {
  /**
   * Whether the reader is done, so nothing more is read: the head has ended, or the budget or a
   * charset stopped it.
   */
  finished = false;
  /** Set when the head declares a charset that the rewriter does not decode with. */
  wrongCharset = false;
  #handled = 0;
  #title: string | undefined;
  #inTitle = false;
  #base: string | undefined;
  readonly #canonicalHrefs: string[] = [];
  readonly #meta: Partial<Record<MetaField, string>> = {};
  readonly #headerCharset: string | undefined;

  /** @param headerCharset The charset the response's `content-type` names, if any. */
  constructor(headerCharset: string | undefined) {
    this.#headerCharset = headerCharset;
  }

  // Marks the reader done and stops the rewriter (see the class comment).
  #stop(): never {
    this.finished = true;
    throw new Error(READER_DONE);
  }

  // Counts a handler call against the budget, and stops the reader when the budget is spent. A
  // handler that runs after the reader is done stops it again.
  #take(): void {
    this.#handled += 1;
    if (this.finished || this.#handled > LOOKUP_ELEMENT_BUDGET) {
      this.#stop();
    }
  }

  rewriter(): HTMLRewriter {
    let rewriter = new HTMLRewriter()
      .on("head", {
        element: (element) => {
          this.#take();
          element.onEndTag(() => this.#stop());
        },
      })
      .on("body", {
        element: () => this.#stop(),
      })
      .on("title", {
        element: (element) => {
          this.#take();
          // Only the first title counts, as for document.title.
          if (this.#title !== undefined) {
            return;
          }
          this.#title = "";
          this.#inTitle = true;
          element.onEndTag(() => {
            this.#inTitle = false;
          });
        },
        // Called for each chunk of a title's text, so it counts as well.
        text: (text) => {
          this.#take();
          if (this.#inTitle) {
            this.#title += text.text;
          }
        },
      })
      .on('link[rel~="canonical" i][href]', {
        element: (element) => {
          this.#take();
          this.#canonicalHrefs.push(decodeHTMLAttribute(element.getAttribute("href") ?? ""));
        },
      })
      .on("base[href]", {
        element: (element) => {
          this.#take();
          // The first base element with an href sets the document's base URL.
          this.#base ??= decodeHTMLAttribute(element.getAttribute("href") ?? "");
        },
      })
      .on("meta[charset]", {
        element: (element) => this.#readCharset(element.getAttribute("charset")),
      })
      .on('meta[http-equiv="content-type" i][content]', {
        element: (element) => this.#readCharset(charsetIn(element.getAttribute("content") ?? "")),
      });
    for (const [field, selector] of META_SELECTORS) {
      rewriter = rewriter.on(selector, {
        element: (element) => this.#readMeta(field, element),
      });
    }
    return rewriter;
  }

  #readMeta(field: MetaField, element: Element): void {
    this.#take();
    const value = decodeHTMLAttribute(element.getAttribute("content") ?? "");
    if (value.trim() !== "") {
      this.#meta[field] ??= value;
    }
  }

  // A charset in the header wins over one in the page, as in a browser. An empty label declares
  // nothing, and a browser ignores it, so it is ignored here too. An unknown label, such as "foo",
  // stops the reader, which is cautious, and saves carrying the Encoding Standard's whole list.
  #readCharset(label: string | null | undefined): void {
    this.#take();
    if (this.#headerCharset !== undefined || label === null || label === undefined) {
      return;
    }
    const declared = asciiLowerCase(decodeHTMLAttribute(label)).replace(EDGE_WHITESPACE, "");
    if (declared !== "" && !UTF8_LABELS.has(declared)) {
      this.wrongCharset = true;
      this.#stop();
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

// Feeds the body to the reader until it is done or the byte limit is reached, then cancels the
// rest of the body, so a large page is never downloaded in full.
async function readHead(response: Response, body: ReadableStream<Uint8Array>): Promise<PageLookup> {
  const contentType = response.headers.get("content-type") ?? "";
  const reader = new HeadReader(charsetIn(contentType));
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
  const rewritten = reader
    .rewriter()
    .transform(new Response(limited, { headers: { "content-type": contentType } }));
  // The rewriter parses as its output is read. The output itself is not needed. When the reader
  // stops the rewriter, the read rejects, and what the reader took is the result. Any other error
  // goes to the caller.
  const output = rewritten.body?.getReader();
  try {
    while (output !== undefined && !(await output.read()).done) {
      // Keep reading.
    }
  } catch (error) {
    if (!reader.finished) {
      throw error;
    }
    await source.cancel().catch(() => {
      // The rest of the body is not wanted.
    });
  }
  if (reader.wrongCharset) {
    return { ok: false, reason: "charset" };
  }
  // After redirects, response.url is the page's final address.
  return { ok: true, metadata: reader.metadata(response.url) };
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
  // A response with no body, such as a 204, says nothing about the page.
  if (response.body === null) {
    return { ok: true, metadata: {} };
  }
  if (mediaType(response.headers.get("content-type") ?? "") !== "text/html") {
    discard(response);
    return { ok: false, reason: "not-html" };
  }
  try {
    return await readHead(response, response.body);
  } catch {
    discard(response);
    return { ok: false, reason: signal.aborted ? "timeout" : "unreadable" };
  }
}
