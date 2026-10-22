// The text of a README, without its Markdown, for enrichment (#123). See "GitHub enrichment" and
// "Untrusted content" in plans/haystack-v1-implementation-plan.md. Anyone can write a README, so
// this only turns it into plain text, and never acts on what it says.
//
// It is not a Markdown parser. It removes the syntax that READMEs use, so that what is left reads
// as prose: front matter, headings, emphasis, links (their text is kept), autolinks (their address
// is kept), images and badges (removed), code fences (removed, because code says little about
// what a repository is for), inline code (its text is kept), block quotes, lists, tables, rules,
// reference definitions, footnotes, hard line breaks, HTML tags and comments, and character
// references. The input may have been cut off anywhere, so a construct that is never closed is
// removed to the end. Indented code blocks are kept, because they can't be told apart from a list
// item's continued lines without parsing.
//
// The CPU time grows with the README's length and no faster, so a hostile README can't make the
// Worker spend its 10 ms on backtracking. No pattern can share one run of characters between two
// of its parts in more than one way, and none follows a run of any length with a backreference
// to it. A pattern that isn't anchored stops at the next character that could end what it
// matches, so it never scans the same text again from each start. readme-excerpt.test.ts times
// 16 KiB of each shape that would break this.
import { truncate } from "@haystack/schemas";
import { decodeHTML } from "entities/decode";

/** How many characters of the README's text are kept. */
export const README_EXCERPT_LENGTH = 2000;

// A fence opens with 3 or more backticks or tildes, indented by up to 3 spaces, and closes with
// at least as many of the same character and nothing else on the line.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// Lines that are only syntax: a thematic break or a setext heading's underline, a table's
// delimiter row, and a link reference definition. In the delimiter row, each run of spaces is
// next to a `|`, a `:` or a `-`, never to another run of spaces.
const RULE = /^ {0,3}([-*_=])(?:[ \t]*\1){2,}[ \t]*$/;
const TABLE_DELIMITER = /^[ \t]*(?:\|[ \t]*)?(?::?-+:?[ \t]*\|[ \t]*)+(?::?-+:?[ \t]*)?$/;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/;

// The markers at the start of a line: block quotes, then a heading, a list item or an alert.
const BLOCK_QUOTE = /^(?:[ \t]*>)+[ \t]?/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const ALERT = /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i;

// ASCII punctuation, which is everything Markdown and HTML syntax is made of.
const PUNCTUATION = /[!-/:-@[-`{-~]/g;

// The private use characters that stand in for punctuation that must stay text: escaped with a
// backslash, or inside a code span. Each is ESCAPE_BASE plus the character's code.
const ESCAPE_BASE = 0xe000;
const PLACEHOLDERS = /[\u{e000}-\u{e07f}]/gu;
const ESCAPED = /\\([!-/:-@[-`{-~])/g;

function placeholder(character: string): string {
  return String.fromCharCode(ESCAPE_BASE + character.charCodeAt(0));
}

// A heading's closing sequence: `#`s at the end, after a space or alone. Done by hand, because a
// pattern for it would try every space as a start.
function withoutClosingHashes(heading: string): string {
  const text = heading.trimEnd();
  let start = text.length;
  while (start > 0 && text[start - 1] === "#") {
    start -= 1;
  }
  if (start === text.length || (start > 0 && text[start - 1] !== " " && text[start - 1] !== "\t")) {
    return text;
  }
  return text.slice(0, start);
}

// YAML front matter: a first line of `---`, up to the next `---` or `...`. Without a closing line,
// the first line is a rule.
function frontMatterEnd(lines: readonly string[]): number {
  if (lines[0] !== "---") {
    return 0;
  }
  const close = lines.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
  return close === -1 ? 0 : close + 1;
}

function removeBlocks(markdown: string): string {
  const source = markdown.split("\n");
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of source.slice(frontMatterEnd(source))) {
    if (fence !== undefined) {
      if (line.trim().startsWith(fence) && line.trim().replaceAll(fence[0] ?? "", "") === "") {
        fence = undefined;
      }
      continue;
    }
    const opening = FENCE.exec(line);
    if (opening !== null) {
      fence = opening[1];
      continue;
    }
    if (RULE.test(line) || TABLE_DELIMITER.test(line) || REFERENCE_DEFINITION.test(line)) {
      continue;
    }
    let text = line.replace(BLOCK_QUOTE, "");
    if (HEADING.test(text)) {
      text = withoutClosingHashes(text.replace(HEADING, ""));
    }
    text = text.replace(LIST_ITEM, "").replace(ALERT, "");
    // A table row's cells become words separated by spaces.
    if (text.trimStart().startsWith("|")) {
      text = text.replaceAll("|", " ");
    }
    lines.push(text);
  }
  return lines.join("\n");
}

// Code spans, found as CommonMark finds them: a run of backticks opens one, and the next run of
// exactly the same length closes it. A run that nothing closes is only backticks. The span's
// text is kept, with its punctuation turned into placeholders, so no later pattern reads it as
// syntax: `<!--` or `<div>` in a code span is text. Done by hand, because a pattern with a
// backreference to a run of backticks would try every length of every run.
function protectCodeSpans(text: string): string {
  const runs = [...text.matchAll(/`+/g)].map((run) => ({
    start: run.index,
    length: run[0].length,
  }));
  // For each length, where its runs are, and how far the search for a closing run has got.
  const byLength = new Map<number, { readonly at: number[]; next: number }>();
  for (const [index, run] of runs.entries()) {
    const same = byLength.get(run.length) ?? { at: [], next: 0 };
    same.at.push(index);
    byLength.set(run.length, same);
  }
  let result = "";
  let copied = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const open = runs[index];
    const same = open === undefined ? undefined : byLength.get(open.length);
    if (open === undefined || same === undefined) {
      continue;
    }
    while ((same.at[same.next] ?? Number.POSITIVE_INFINITY) <= index) {
      same.next += 1;
    }
    const closeIndex = same.at[same.next];
    const close = closeIndex === undefined ? undefined : runs[closeIndex];
    if (closeIndex === undefined || close === undefined) {
      continue;
    }
    const code = text.slice(open.start + open.length, close.start).replaceAll("\n", " ");
    result += text.slice(copied, open.start) + code.replace(PUNCTUATION, placeholder);
    copied = close.start + close.length;
    index = closeIndex;
  }
  return result + text.slice(copied);
}

// An autolink keeps its address as text, without `mailto:`.
function autolinkText(_: string, address: string): string {
  return address.replace(/^mailto:/i, "");
}

function removeInline(text: string): string {
  return (
    protectCodeSpans(text)
      // Comments, then the contents of elements that are never text. A tag ends at the first
      // `>`, so one with `>` inside a quoted attribute leaves the rest of the attribute behind,
      // which is only noise.
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/<(script|style|svg)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
      // Images and badges, inline and by reference, before links, so a linked badge leaves a
      // link with no text, which the link pattern removes. The alternative text stays on one
      // line, so a `![` that nothing closes doesn't take the prose after it.
      .replace(/!\[[^[\]\n]*\](?:\((?:[^()\n]|\([^()\n]*\))*\)|\[[^[\]\n]*\])?/g, "")
      // Links keep their text, which may hold one level of brackets: inline, by reference, and
      // footnote references go entirely.
      .replace(/\[\^[^[\]\n]*\]/g, "")
      .replace(/\[((?:[^[\]]|\[[^[\]]*\])*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1")
      .replace(/\[((?:[^[\]]|\[[^[\]]*\])*)\]\[[^[\]\n]*\]/g, "$1")
      // Autolinks keep their address. Then every tag goes, including one cut off at the end.
      .replace(/<((?:https?|mailto):[^<>\s]*)>/gi, autolinkText)
      .replace(/<([^<>\s@]+@[^<>\s@]+)>/g, "$1")
      .replace(/<\/?[A-Za-z][^<>]*(?:>|$)/g, " ")
      // Backticks that no code span used, and strikethrough.
      .replaceAll("`", "")
      .replaceAll("~~", "")
  );
}

// `*`, `**` and `***` around text, and the same with `_` when it isn't inside a word, as in
// snake_case. Twice, so emphasis inside emphasis goes too.
function removeEmphasis(text: string): string {
  let result = text;
  for (let pass = 0; pass < 2; pass += 1) {
    result = result
      .replace(/(\*{1,3})(?=[^\s*])([^*\n]*?[^\s*])\1/g, "$2")
      .replace(/(^|[^\p{L}\p{N}_])(_{1,3})(?=[^\s_])([^_\n]*?[^\s_])\2(?![\p{L}\p{N}_])/gu, "$1$3");
  }
  return result;
}

/**
 * The README's text, without its Markdown syntax, cut to README_EXCERPT_LENGTH characters. Lines
 * are kept, so headings and paragraphs stay apart, but blank lines and runs of spaces are not.
 */
export function readmeExcerpt(markdown: string): string {
  const escaped = markdown
    .replace(/\r\n?/g, "\n")
    .replace(PLACEHOLDERS, "")
    // A backslash at the end of a line is a hard line break, which a line already is.
    .replace(/\\$/gm, "")
    .replace(ESCAPED, (_, character: string) => placeholder(character));
  const text = decodeHTML(removeEmphasis(removeInline(removeBlocks(escaped)))).replace(
    PLACEHOLDERS,
    (character) => String.fromCharCode(character.charCodeAt(0) - ESCAPE_BASE),
  );
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
  return truncate(lines.join("\n"), README_EXCERPT_LENGTH).trimEnd();
}
