// The text of a README, without its Markdown, for enrichment (#123). See "GitHub enrichment" and
// "Untrusted content" in plans/haystack-v1-implementation-plan.md. Anyone can write a README, so
// this only turns it into plain text, and never acts on what it says.
//
// It is not a Markdown parser. It removes the syntax that READMEs use, so that what is left reads
// as prose: headings, emphasis, links (their text is kept), images and badges (removed), code
// fences (removed, because code says little about what a repository is for), inline code (its
// text is kept), block quotes, lists, tables, rules, reference definitions, footnotes, HTML tags
// and comments, and character references. The input may have been cut off anywhere, so a
// construct that is never closed is removed to the end.
//
// The CPU time is bounded as well as the input. Every pattern below either matches in one pass
// or stops at the next character that could end it, so a hostile README of the read limit's size
// can't make the Worker spend its 10 ms on backtracking. The tests time such a README.
import { truncate } from "@haystack/schemas";
import { decodeHTML } from "entities/decode";

/** How many characters of the README's text are kept. */
export const README_EXCERPT_LENGTH = 2000;

// A fence opens with 3 or more backticks or tildes, indented by up to 3 spaces, and closes with
// at least as many of the same character and nothing else on the line.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// Lines that are only syntax: a thematic break or a setext heading's underline, a table's
// delimiter row, and a link reference definition.
const RULE = /^ {0,3}([-*_=])(?:[ \t]*\1){2,}[ \t]*$/;
const TABLE_DELIMITER = /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?$/;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/;

// The markers at the start of a line: block quotes, then a heading, a list item or an alert.
const BLOCK_QUOTE = /^(?:[ \t]*>)+[ \t]?/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const CLOSING_HASHES = /[ \t]+#+[ \t]*$/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const ALERT = /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i;

// The private use characters that stand in for escaped punctuation while the syntax is removed.
const ESCAPE_BASE = 0xe000;
const PLACEHOLDERS = /[-]/g;
const ESCAPED = /\\([!-/:-@[-`{-~])/g;

function removeBlocks(markdown: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
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
      text = text.replace(HEADING, "").replace(CLOSING_HASHES, "");
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

function removeInline(text: string): string {
  return (
    text
      // Comments, then the contents of elements that are never text, then every tag. A tag ends
      // at the first `>`, so one with `>` inside a quoted attribute leaves the rest of the
      // attribute behind, which is only noise.
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/<(script|style|svg)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
      // Images and badges, inline and by reference, before links, so a linked badge leaves a
      // link with no text, which the next pattern removes.
      .replace(/!\[[^[\]]*\](?:\((?:[^()\n]|\([^()\n]*\))*\)|\[[^[\]\n]*\])?/g, "")
      // Links keep their text: inline, by reference, and footnote references go entirely.
      .replace(/\[\^[^[\]\n]*\]/g, "")
      .replace(/\[([^[\]]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1")
      .replace(/\[([^[\]]*)\]\[[^[\]\n]*\]/g, "$1")
      // Autolinks and tags, including a tag cut off at the end of the input.
      .replace(/<(?:https?:|mailto:)[^<>\s]*>/gi, "")
      .replace(/<\/?[A-Za-z][^<>]*(?:>|$)/g, " ")
      // Inline code keeps its text.
      .replace(/(`+)([^`]+?)\1/g, "$2")
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
    .replace(ESCAPED, (_, character: string) =>
      String.fromCharCode(ESCAPE_BASE + character.charCodeAt(0)),
    );
  const text = decodeHTML(removeEmphasis(removeInline(removeBlocks(escaped)))).replace(
    PLACEHOLDERS,
    (placeholder) => String.fromCharCode(placeholder.charCodeAt(0) - ESCAPE_BASE),
  );
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
  return truncate(lines.join("\n"), README_EXCERPT_LENGTH).trimEnd();
}
