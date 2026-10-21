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
//   of up to four capitals (`API`), or one of these followed by capitalized words (`iPhone`,
//   `SignedHeaders`). A random mix of cases or of letters and digits, as in `1aBcD9xQ` or
//   `k3j9x2m1`, fails this.
// - A piece has at most 20 characters, the whole part at most 80, and the whole part at most 8
//   digits, so a long token, a long number and a number split by separators are masked.
// - No piece has more than four consonants in a row (`y` counts as a vowel), which catches many
//   random lowercase strings such as `xkqrzpmt`. A few real words fail it (`strengths`, `https`),
//   and they are masked, which is the safe direction.
//
// A short random string of lowercase letters can still pass, because telling it from a word
// would need a dictionary. Such a string has little room for a secret, and the title and host
// give Jev more evidence than it does.
const WORD_LIKE_MAX_LENGTH = 80;
const WORD_LIKE_MAX_DIGITS = 8;
const PIECE_MAX_LENGTH = 20;
const WORD_LIKE_CHARACTERS = /^[A-Za-z0-9._ -]+$/;
const SEPARATORS = /[._ -]+/;
const LETTERS = "(?:[a-z]+|[A-Z][a-z]+|[A-Z]{1,4})(?:[A-Z][a-z]+)*";
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

// Percent-decoding for a path segment or an anchor, where `+` is not a space, so it is escaped
// before the form decoding. Invalid escapes stay as written, as they do for parameters.
function percentDecoded(raw: string): string {
  return formDecoded(raw.replaceAll("+", "%2B"));
}

// Every masked part, raw and decoded, with its placeholder, so the title can be checked for
// them. It belongs to one call of describeUrlForJudgment.
type Masked = Map<string, string>;

function mask(raw: string, text: string, masked: Masked): string {
  const shape = placeholder(text);
  masked.set(raw, shape).set(text, shape);
  return shape;
}

// A path segment, parameter name or anchor: kept, decoded, when it is word-like, and masked
// otherwise. A kept part has only ASCII letters, digits, separators and spaces, so it can't be
// mistaken for a placeholder, and it never contains `/`, `=` or `&`.
function keptOrMasked(raw: string, text: string, masked: Masked): string {
  return isWordLike(text) ? text : mask(raw, text, masked);
}

// Empty segments are kept, so `/docs/` and `/docs` stay different.
function describePath(path: string, masked: Masked): string {
  return path
    .split("/")
    .map((segment) =>
      segment === "" ? "" : keptOrMasked(segment, percentDecoded(segment), masked),
    )
    .join("/");
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
        name: keptOrMasked(rawName, formDecoded(rawName), masked),
        value: mask(rawValue, formDecoded(rawValue), masked),
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
    anchor = keptOrMasked(head, percentDecoded(head), masked);
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

// Masked text shorter than this is not searched for in the title. It would match ordinary
// words (`?page=2` in "Page 2 of 10"), and so short a part has no room for a secret.
const TITLE_MATCH_MIN_LENGTH = 4;

type MaskedPart = readonly [text: string, shape: string];

// The longest ending of the title that is a masked part, or the start of one, and that part's
// placeholder. When a whole part and the start of a longer one are equally long, the whole part's
// placeholder is the one that describes the text.
function maskedEnding(
  title: string,
  parts: readonly MaskedPart[],
): readonly [length: number, shape: string] | undefined {
  let longest: readonly [length: number, shape: string] | undefined;
  for (const [text, shape] of parts) {
    for (let length = text.length; length >= TITLE_MATCH_MIN_LENGTH; length -= 1) {
      if (title.endsWith(text.slice(0, length))) {
        const best = longest?.[0] ?? 0;
        if (length > best || (length === best && length === text.length)) {
          longest = [length, shape];
        }
        break;
      }
    }
  }
  return longest;
}

// The title with every masked part of the URL in it replaced by that part's placeholder. A title
// can hold the URL: the save form falls back to the full address when a page has no title, and a
// browser can show an untitled page's address as its tab title. Such a title may also be cut to
// its cap partway through a part, so an ending that is the start of a masked part is replaced
// too. The rest is read once from the start, and at each position the longest masked part found
// there is replaced, so a part inside a longer one, or inside a placeholder, is never matched.
function titleWithoutMaskedText(title: string, masked: Masked): string {
  const parts: MaskedPart[] = [...masked]
    .filter(([text]) => text.length >= TITLE_MATCH_MIN_LENGTH)
    .sort(([a], [b]) => b.length - a.length);
  const ending = maskedEnding(title, parts);
  const end = title.length - (ending?.[0] ?? 0);
  let result = "";
  let index = 0;
  while (index < end) {
    const part = parts.find(
      ([text]) => index + text.length <= end && title.startsWith(text, index),
    );
    if (part === undefined) {
      result += title.charAt(index);
      index += 1;
    } else {
      result += part[1];
      index += part[0].length;
    }
  }
  return ending === undefined ? result : `${result}${ending[1]}`;
}

/**
 * Describes a URL for the Jev sensitivity check without any of its values: the scheme and host
 * (the parser's, so an internationalized host is in punycode, with any port), the path with each
 * segment that is not word-like masked, the query and fragment parameter names with a
 * placeholder for every value, and the captured page title. `declares_sensitive_canonical` is
 * included, as `true`, only when the page declared a canonical URL that detectSensitiveUrl
 * flagged; that URL itself is never part of the description. Credentials in the URL are never
 * included, and any masked part of the URL that appears in the title is masked there too.
 *
 * The function sends nothing anywhere and does not change the URL it is given.
 */
export function describeUrlForJudgment(
  url: URL,
  title: string | undefined,
  declaresSensitiveCanonical: boolean,
): UrlDescription {
  const masked: Masked = new Map();
  for (const credential of [url.username, url.password]) {
    if (credential !== "") {
      mask(credential, percentDecoded(credential), masked);
    }
  }
  const path = describePath(url.pathname, masked);
  const query = describeParameters(url.search.slice(1), masked);
  const fragment = describeFragment(url.hash.slice(1), masked);
  return {
    scheme: url.protocol.slice(0, -1),
    host: url.host,
    path,
    ...(query.length === 0 ? {} : { query }),
    ...(fragment === undefined ? {} : { fragment }),
    ...(title === undefined || title === ""
      ? {}
      : { title: titleWithoutMaskedText(title, masked) }),
    ...(declaresSensitiveCanonical ? { declares_sensitive_canonical: true as const } : {}),
  };
}
