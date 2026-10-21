// The only description of a URL that Jev ever sees. See "Probabilistic check with Jev" in
// plans/haystack-v1-implementation-plan.md. The sensitivity check asks whether a link works as a
// key, and a link that does is exactly what must not leave Haystack, so the description keeps
// the URL's shape and leaves out its content. Every query and fragment value becomes a
// placeholder, and so does every path segment, parameter name and anchor that is not word-like.
// A borderline part is masked, because a lost word costs Jev some evidence, while a kept secret
// cannot be taken back.

/**
 * A query or fragment parameter. The name is kept when it is word-like and is a placeholder
 * otherwise. The value is always a placeholder.
 */
export interface DescribedParameter {
  readonly name: string;
  readonly value: string;
}

/**
 * What the fragment holds. A hash route (`#/callback?code=…`) has a `route`, described like the
 * path, and the parameters after its `?`. A fragment of `key=value` pairs (`#state=…`) has only
 * parameters. Anything else is an `anchor`, such as a heading's id, kept when it is word-like.
 * A key is absent when the fragment has no such part.
 */
export interface DescribedFragment {
  readonly route?: string;
  readonly anchor?: string;
  readonly parameters?: readonly DescribedParameter[];
}

/**
 * The state sent to Jev for one URL. Parameters are lists rather than objects, so repeated names
 * keep their order and a name such as `__proto__` is only data. A key is absent when the URL has
 * no such part, and `declares_sensitive_canonical` is present only when it is true. The user name
 * and password are never included, and neither is the canonical URL.
 */
export interface UrlDescription {
  readonly scheme: string;
  readonly host: string;
  readonly path: string;
  readonly query?: readonly DescribedParameter[];
  readonly fragment?: DescribedFragment;
  readonly title?: string;
  readonly declares_sensitive_canonical?: true;
}

// The word-like rule. A part of a URL is word-like when, after percent-decoding, it reads as
// words a person chose, such as `document`, `edit`, `usp`, `X-Amz-Signature`, `index.html`,
// `how-to-use-css-grid-in-2026` or `Quarterly Report.pdf`. Each limit below is there because
// random strings break it:
//
// - Only ASCII letters, digits, `-`, `_`, `.` and the space are allowed, so anything with `%`,
//   `+`, `/`, `=`, `~` or a non-ASCII letter is masked. Base64 tokens usually have `+`, `/` or
//   `=`.
// - The separators (`-`, `_`, `.` and the space) split the part into pieces, and every piece
//   must be one of: letters, a number of up to four digits, or letters and such a number joined
//   (`v2`, `es2023`, `4k`). Letters are lowercase (`grid`), capitalized (`Roadmap`), an acronym
//   of up to four capitals (`API`), or one of these followed by capitalized words of at least
//   three letters (`iPhone`, `SignedHeaders`, `McDonald`). A random mix of cases or of letters
//   and digits, as in `1aBcD9xQ`, `k3j9x2m1` or `AbCdEf`, fails this. Requiring three letters
//   in each later word is what masks alternating case: with two, about 11 in 100 random
//   8-letter mixed-case strings passed, and with three, about 5 in 100 do.
// - A piece has at most 20 characters, the whole part at most 80, and the whole part at most 8
//   digits, so a long token, a long number and a number split by separators are masked.
// - No piece has more than four consonants in a row (`y` counts as a vowel), which catches many
//   random lowercase strings such as `xkqrzpmt`. A few real words fail it (`strengths`, `https`),
//   and they are masked, which is the safe direction.
//
// Random lowercase letters often pass, because telling them from words would need a dictionary.
// Measured with random strings, about 61 in 100 of 7 letters pass, 55 in 100 of 8 letters, and
// 42 in 100 of 10 letters. Formats that pass include Google Meet codes (`abc-defg-hij`, every
// one), Discord invites (`discord.gg/batomek`), invite codes made from a word list
// (`apple-river-stone-cloud`, `WiseKittensTalk`) and short numeric room codes (`1234-5678`).
// Jev also sees the host, which names the service. Masking these without masking ordinary slugs
// such as `how-to-use-css` is tracked in #135.
const WORD_LIKE_MAX_LENGTH = 80;
const WORD_LIKE_MAX_DIGITS = 8;
const PIECE_MAX_LENGTH = 20;
const WORD_LIKE_CHARACTERS = /^[A-Za-z0-9._ -]+$/;
const SEPARATORS = /[._ -]+/;
const LETTERS = "(?:[a-z]+|[A-Z][a-z]+|[A-Z]{1,4})(?:[A-Z][a-z]{2,})*";
const NUMBER = "[0-9]{1,4}";
const PIECE = new RegExp(`^(?:${LETTERS}|${NUMBER}|${LETTERS}${NUMBER}|${NUMBER}${LETTERS})$`);
const LONG_CONSONANT_RUN = /[bcdfghjklmnpqrstvwxz]{5}/i;

function isWordLikePiece(piece: string): boolean {
  return piece.length <= PIECE_MAX_LENGTH && PIECE.test(piece) && !LONG_CONSONANT_RUN.test(piece);
}

function isWordLike(text: string): boolean {
  if (text.length > WORD_LIKE_MAX_LENGTH || !WORD_LIKE_CHARACTERS.test(text)) {
    return false;
  }
  if (text.replace(/[^0-9]/g, "").length > WORD_LIKE_MAX_DIGITS) {
    return false;
  }
  const pieces = text.split(SEPARATORS).filter((piece) => piece !== "");
  return pieces.length > 0 && pieces.every(isWordLikePiece);
}

// The placeholder grammar. A placeholder is `<empty>` for an empty value, or `<class:length>`,
// where the length counts the decoded text's characters (Unicode code points) and the class is
// the first of these that fits:
//
// - `digits`: only the digits 0 to 9, such as an id or a timestamp.
// - `word`: word-like, as above. Only a value can get this class, because a word-like path
//   segment, name or anchor is kept as it is.
// - `hex`: only hexadecimal digits, all in one case, such as a hash or a signature.
// - `random`: anything else, from a token to a word with a non-ASCII letter.
//
// A placeholder says how long a part is and which characters it uses, and nothing else, so no
// character of the part itself reaches Jev.
type ShapeClass = "digits" | "word" | "hex" | "random";

const ONLY_DIGITS = /^[0-9]+$/;
const ONLY_HEX = /^(?:[0-9a-f]+|[0-9A-F]+)$/;

function shapeClass(text: string): ShapeClass {
  if (ONLY_DIGITS.test(text)) {
    return "digits";
  }
  if (isWordLike(text)) {
    return "word";
  }
  return ONLY_HEX.test(text) ? "hex" : "random";
}

function placeholder(text: string): string {
  if (text === "") {
    return "<empty>";
  }
  // oxlint-disable-next-line no-misused-spread -- the length counts code points on purpose.
  const length = [...text].length;
  return `<${shapeClass(text)}:${length}>`;
}

// A name or value as a server reads it, with URLSearchParams decoding: `+` is a space, valid
// percent-escapes are decoded, and invalid ones (`%zz`) stay as written. The text contains no
// `&`, because the caller splits pairs on it, and no `=` that matters, because everything after
// the `_=` prefix is read as the value, so the text comes back whole.
function formDecoded(raw: string): string {
  return new URLSearchParams(`_=${raw}`).get("_") ?? raw;
}

// Percent-decoding for a path segment, an anchor or a whole address, where `+` is not a space
// and `&` is ordinary text. Each run of escapes is decoded on its own, so an invalid escape
// (`%zz`) or an escaped byte sequence that is not UTF-8 stays as written instead of throwing.
function percentDecoded(raw: string): string {
  return raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

// Every masked part, in each form it can take in a title (as written and decoded), with its
// placeholder. It belongs to one call of describeUrlForJudgment.
type Masked = Map<string, string>;

// Masks the decoded text, and records it with its other forms.
function mask(text: string, forms: readonly string[], masked: Masked): string {
  const shape = placeholder(text);
  for (const form of [text, ...forms]) {
    masked.set(form, shape);
  }
  return shape;
}

// A path segment, parameter name or anchor: kept, decoded, when it is word-like, and masked
// otherwise. A kept part has only ASCII letters, digits, separators and spaces, so it can't be
// mistaken for a placeholder, and it never contains `/`, `=` or `&`.
function keptOrMasked(text: string, forms: readonly string[], masked: Masked): string {
  return isWordLike(text) ? text : mask(text, forms, masked);
}

// Empty segments are kept, so `/docs/` and `/docs` stay different.
function describePath(path: string, masked: Masked): string {
  return path
    .split("/")
    .map((segment) =>
      segment === "" ? "" : keptOrMasked(percentDecoded(segment), [segment], masked),
    )
    .join("/");
}

// A parameter's name or value is masked as a server reads it, and also recorded decoded with
// `+` kept, the way decodeURIComponent shows it, since a title can hold either.
function parameterForms(raw: string): readonly [text: string, forms: readonly string[]] {
  return [formDecoded(raw), [raw, percentDecoded(raw)]];
}

// Each `name=value` pair in order, repeated names included. A pair without `=` has an empty
// value, as URLSearchParams reads it.
function describeParameters(source: string, masked: Masked): DescribedParameter[] {
  return source
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const separator = pair.indexOf("=");
      const rawName = separator === -1 ? pair : pair.slice(0, separator);
      const rawValue = separator === -1 ? "" : pair.slice(separator + 1);
      return {
        name: keptOrMasked(...parameterForms(rawName), masked),
        value: mask(...parameterForms(rawValue), masked),
      };
    });
}

// The fragment's part before its first `?` is a route when it starts with `/` (or `!/`, the
// older hashbang form), parameters when it has `=` or `&`, and an anchor otherwise. The part
// after the first `?` is always parameters, as detectSensitiveUrl reads a hash route's query.
function describeFragment(fragment: string, masked: Masked): DescribedFragment | undefined {
  const queryStart = fragment.indexOf("?");
  const head = queryStart === -1 ? fragment : fragment.slice(0, queryStart);
  const tail = queryStart === -1 ? "" : fragment.slice(queryStart + 1);
  let route: string | undefined;
  let anchor: string | undefined;
  let headParameters: DescribedParameter[] = [];
  if (head.startsWith("/")) {
    route = describePath(head, masked);
  } else if (head.startsWith("!/")) {
    route = `!${describePath(head.slice(1), masked)}`;
  } else if (head.includes("=") || head.includes("&")) {
    headParameters = describeParameters(head, masked);
  } else if (head !== "") {
    anchor = keptOrMasked(percentDecoded(head), [head], masked);
  }
  const parameters = [...headParameters, ...describeParameters(tail, masked)];
  if (route === undefined && anchor === undefined && parameters.length === 0) {
    return undefined;
  }
  return {
    ...(route === undefined ? {} : { route }),
    ...(anchor === undefined ? {} : { anchor }),
    ...(parameters.length === 0 ? {} : { parameters }),
  };
}

// A title is checked in one of two ways, depending on whether it holds the address.
//
// A title can be the address itself: the save form falls back to the full address when a page
// has no title, and a browser can show an untitled page's address as its tab title. Such a title
// may also be cut to its cap partway through a value. Masking it piece by piece would mean
// reading it as a URL a second time, short values such as `?pin=123` included, and it would
// still tell Jev nothing the description does not. So a title with a word that looks like the
// address is left out.
//
// Any other title is ordinary text, and only whole masked parts of four or more characters are
// replaced in it. A shorter part would match ordinary words (`?page=2` in "Page 2 of 10"), and
// the start of a part would match a word that merely begins the same way (`?q=how+to+cook` in
// "Results for how to"). A secret that is in the title but not, whole, in the URL, such as a
// token inside an encoded redirect value, is not caught (#136).

const TITLE_MATCH_MIN_LENGTH = 4;

// Characters that often wrap an address in running text, as in "(https://…)" or "see
// https://….". Trimming them only shortens a word, so the start of the address stays its start.
const WRAPPING_PUNCTUATION = /^[("'<[]+|[)"'>\],.;:!?]+$/g;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// A word looks like the address when it is either of these:
//
// - The start of the address as the parser writes it, or percent-decoded. With the scheme, the
//   word must go past `https://`. Without it, the word must go past the host, so that a title
//   that only names the site ("example.com") is still a title.
// - An address with the same host and something after it, read as an https address when it has
//   no scheme. This covers a form the first test can't compare, such as an internationalized
//   host in Unicode (`bücher.example/…`) or a host in capitals.
function looksLikeTheAddress(word: string, url: URL): boolean {
  const schemeLength = url.protocol.length + 2;
  for (const form of [url.href, percentDecoded(url.href)]) {
    if (word.length > schemeLength && form.startsWith(word)) {
      return true;
    }
    const withoutScheme = form.slice(schemeLength);
    const hostEnd = withoutScheme.indexOf(url.host) + url.host.length;
    if (word.length > hostEnd && withoutScheme.startsWith(word)) {
      return true;
    }
  }
  const parsed = URL.parse(HAS_SCHEME.test(word) ? word : `https://${word}`);
  return (
    parsed !== null &&
    parsed.host === url.host &&
    (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "")
  );
}

function holdsTheAddress(title: string, url: URL): boolean {
  return title
    .split(/\s+/)
    .map((word) => word.replace(WRAPPING_PUNCTUATION, ""))
    .some((word) => word !== "" && looksLikeTheAddress(word, url));
}

// The title with every whole masked part of four or more characters replaced by its placeholder.
// The title is read once from the start, and at each position the longest masked part found
// there is replaced, so a part inside a longer one, or inside a placeholder, is never matched.
function titleWithoutMaskedText(title: string, masked: Masked): string {
  const parts = [...masked]
    .filter(([text]) => text.length >= TITLE_MATCH_MIN_LENGTH)
    .sort(([a], [b]) => b.length - a.length);
  let result = "";
  let index = 0;
  while (index < title.length) {
    const part = parts.find(([text]) => title.startsWith(text, index));
    if (part === undefined) {
      result += title.charAt(index);
      index += 1;
    } else {
      result += part[1];
      index += part[0].length;
    }
  }
  return result;
}

function describeTitle(title: string | undefined, url: URL, masked: Masked): string | undefined {
  if (title === undefined || title === "" || holdsTheAddress(title, url)) {
    return undefined;
  }
  return titleWithoutMaskedText(title, masked);
}

/**
 * Describes a URL for the Jev sensitivity check without any of its values: the scheme and host
 * (the parser's, so an internationalized host is in punycode, with any port), the path with each
 * segment that is not word-like masked, the query and fragment parameter names with a
 * placeholder for every value, and the captured page title. `declares_sensitive_canonical` is
 * included, as `true`, only when the page declared a canonical URL that detectSensitiveUrl
 * flagged; that URL itself is never part of the description. Credentials in the URL are never
 * included. A title that holds the address is left out, and in any other title the URL's masked
 * parts of four or more characters are masked too.
 *
 * The function sends nothing anywhere and does not change the URL it is given. Throws a
 * TypeError for a URL whose scheme is not http or https, as normalizeUrl does, because Haystack
 * saves only web pages and the description is written for their shape.
 */
export function describeUrlForJudgment(
  url: URL,
  title: string | undefined,
  declaresSensitiveCanonical: boolean,
): UrlDescription {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("describeUrlForJudgment only accepts http and https URLs");
  }
  const masked: Masked = new Map();
  for (const credential of [url.username, url.password]) {
    if (credential !== "") {
      mask(percentDecoded(credential), [credential], masked);
    }
  }
  const path = describePath(url.pathname, masked);
  const query = describeParameters(url.search.slice(1), masked);
  const fragment = describeFragment(url.hash.slice(1), masked);
  const describedTitle = describeTitle(title, url, masked);
  return {
    scheme: url.protocol.slice(0, -1),
    host: url.host,
    path,
    ...(query.length === 0 ? {} : { query }),
    ...(fragment === undefined ? {} : { fragment }),
    ...(describedTitle === undefined ? {} : { title: describedTitle }),
    ...(declaresSensitiveCanonical ? { declares_sensitive_canonical: true as const } : {}),
  };
}
