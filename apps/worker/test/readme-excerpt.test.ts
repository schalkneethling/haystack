// The README excerpt (#123): its Markdown is removed, its length is capped, and a hostile README
// can't make it slow. See "GitHub enrichment" in plans/haystack-v1-implementation-plan.md.
import { describe, expect, it } from "vite-plus/test";
import { README_EXCERPT_LENGTH, readmeExcerpt } from "../src/enrichment/readme-excerpt.ts";
import { SAMPLE_README } from "./github-fixture.ts";

describe("readmeExcerpt", () => {
  it("keeps the text and removes the syntax", () => {
    expect(readmeExcerpt(SAMPLE_README)).toBe(
      [
        "Vitest",
        "Next generation testing framework powered by Vite.",
        "Setext heading",
        "Features",
        "Fast by default, with native ESM",
        "Slow watch mode, like jest --watch",
        "Works with snake_case_names and 2 * 3 = 6",
        "Task done",
        "Feature Status",
        "Watch Done",
        "See the guide and https://vitest.test/docs.",
        "Escaped *stars* stay, and so do <angle brackets> & entities.",
        "More Hidden details",
      ].join("\n"),
    );
  });

  it("is at most 2,000 characters", () => {
    // The issue's limit, written out, so a change to the constant fails here.
    expect(README_EXCERPT_LENGTH).toBe(2000);
    const long = Array.from({ length: 400 }, (_, index) => `Paragraph ${index} of prose.`).join(
      "\n\n",
    );
    const excerpt = readmeExcerpt(long);
    expect(excerpt.length).toBeLessThanOrEqual(2000);
    expect(excerpt.length).toBeGreaterThan(2000 - 30);
    expect(excerpt.startsWith("Paragraph 0 of prose.\nParagraph 1 of prose.")).toBe(true);
  });

  it("doesn't split a surrogate pair at the cut", () => {
    const excerpt = readmeExcerpt(`${"a".repeat(README_EXCERPT_LENGTH - 1)}😀 more`);
    expect(excerpt).toBe("a".repeat(README_EXCERPT_LENGTH - 1));
  });

  it("removes a construct that the read limit cut off", () => {
    expect(readmeExcerpt("Intro\n```js\nconst x = 1;")).toBe("Intro");
    expect(readmeExcerpt("Intro <!-- a comment that never")).toBe("Intro");
    expect(readmeExcerpt('Intro <img src="https://cdn.test/a.png" alt="cut')).toBe("Intro");
  });

  it("is empty for a README that is only syntax", () => {
    expect(readmeExcerpt('<p align="center"><img src="logo.svg"></p>\n\n---\n')).toBe("");
  });

  it("keeps the prose after a `![` that nothing closes on its line", () => {
    // An image's alternative text can't span lines here, so this is text, as its author wrote it.
    expect(readmeExcerpt("Use ![ to insert. More prose here.\nThen ] end.")).toBe(
      "Use ![ to insert. More prose here.\nThen ] end.",
    );
  });

  it("keeps an autolink's address", () => {
    expect(readmeExcerpt("Docs: <https://example.test/docs>, mail <mailto:hi@example.test>.")).toBe(
      "Docs: https://example.test/docs, mail hi@example.test.",
    );
    expect(readmeExcerpt("Write to <team@example.test>.")).toBe("Write to team@example.test.");
  });

  it("removes a backslash hard line break", () => {
    expect(readmeExcerpt("First line\\\nSecond line\\")).toBe("First line\nSecond line");
  });

  it("keeps a code span's text, even when it looks like a comment or a tag", () => {
    expect(
      readmeExcerpt("Write `<!--` to start a comment.\nKeep this line. `<div>` and `**`."),
    ).toBe("Write <!-- to start a comment.\nKeep this line. <div> and **.");
    expect(readmeExcerpt("Two ``with ` inside`` and `unclosed")).toBe(
      "Two with ` inside and unclosed",
    );
  });

  // CommonMark reads inline content one paragraph at a time, so a backtick with no closer in its
  // paragraph is only a backtick, and goes with the other stray ones.
  it("doesn't let a code span cross a blank line", () => {
    expect(readmeExcerpt("don`t do it\n\nUse `code` here")).toBe("dont do it\nUse code here");
    expect(
      readmeExcerpt("Start `oops\n\n# Heading **bold** [link](https://x.test)\n\nEnd` done"),
    ).toBe("Start oops\nHeading bold link\nEnd done");
  });

  it("doesn't let a code span cross a heading, a list item or a fence", () => {
    expect(readmeExcerpt("Start `oops\n# Heading **bold**\nEnd` done")).toBe(
      "Start oops\nHeading bold\nEnd done",
    );
    expect(readmeExcerpt("- one `oops\n- two **bold**\n- three` done")).toBe(
      "one oops\ntwo bold\nthree done",
    );
    expect(readmeExcerpt("Start `oops\n```\ncode\n```\nEnd **bold**` done")).toBe(
      "Start oops\nEnd bold done",
    );
  });

  // The placeholders stand in for punctuation that must stay text. One already in the README, or
  // written as a character reference, must not turn into that punctuation or anything else.
  it("removes placeholder characters that are already in the README", () => {
    expect(readmeExcerpt("a\u{e02a}b\u{e02a} *c* \u{e000}d")).toBe("ab c d");
  });

  it.each([
    ["&#xE000;", "a&#xE000;b", "ab"],
    ["&#xE001;", "a&#xe001;b", "ab"],
    ["&#57388;", "a&#57388;b", "ab"],
    ["&#xE02A without its semicolon", "a&#xE02A-b", "a-b"],
  ])("removes a reference to the placeholder %s, rather than decode it", (_, markdown, text) => {
    expect(readmeExcerpt(markdown)).toBe(text);
  });

  it("still decodes references outside the placeholder range", () => {
    expect(readmeExcerpt("&#x2A;&#42;&#xDFFF;&#xE080;")).toBe("**\u{fffd}\u{e080}");
  });

  it("keeps a link's text that holds brackets", () => {
    expect(readmeExcerpt("See [the [b] guide](https://example.test/guide) now.")).toBe(
      "See the [b] guide now.",
    );
  });

  it("removes YAML front matter", () => {
    expect(readmeExcerpt("---\ntitle: Vitest\nlayout: home\n---\n# Vitest\nText.")).toBe(
      "Vitest\nText.",
    );
    // Without a closing line, the first `---` is a rule.
    expect(readmeExcerpt("---\ntitle: Vitest")).toBe("title: Vitest");
  });

  it("keeps a heading's text that ends in #", () => {
    expect(readmeExcerpt("# Notes on C#\n## Install ##")).toBe("Notes on C#\nInstall");
  });

  // Each of these is about 16 KiB, the client's read limit, of a shape that a backtracking
  // pattern takes quadratic time over: a construct that opens again and again and never closes,
  // or a long run that two parts of a pattern could share. Measured in Node 24 on an Apple
  // silicon Mac, each took under 2.5 ms, and the slowest, backticks in many paragraphs, took
  // 2.2 ms. The first four took 120 to 300 ms each with the patterns of 09bad9d. 50 ms
  // catches that and leaves room for a slow machine. Each test times 5 calls and checks the
  // fastest, because a busy machine slows some calls down (single calls under load took up to
  // 87 ms) but a quadratic pattern makes every call slow.
  const hostile: [string, string][] = [
    ["a run of backticks after text", `a${"`".repeat(16383)}`],
    ["spaces before text", `${" ".repeat(16383)}x`],
    ["spaces before a list marker", `${" ".repeat(16382)}-x`],
    ["spaces inside a heading", `# a${" ".repeat(16380)}x`],
    [
      "backtick runs of many lengths",
      Array.from({ length: 180 }, (_, i) => `${"`".repeat(i + 1)}a`).join(""),
    ],
    ["unclosed links", "[a](".repeat(4096)],
    ["unclosed nested links", `[${"[a]".repeat(5461)}`],
    ["unclosed images", "![a](b ".repeat(2340)],
    ["unclosed emphasis", "**a ".repeat(4096)],
    ["unclosed underscores", " __a".repeat(4096)],
    ["unclosed inline code", "`a ".repeat(5461)],
    ["unclosed tags", "<a b='".repeat(2730)],
    ["unclosed script tags", "<script ".repeat(2048)],
    ["unclosed email autolinks", "<a@".repeat(5461)],
    ["unclosed brackets", "[".repeat(16384)],
    ["nested parentheses", `[a](${"(".repeat(16380)}`],
    ["unclosed fences", "```\n~~~~\n".repeat(1820)],
    ["backticks in many paragraphs", "`a\n \n".repeat(3276)],
    ["unclosed character references", "&#x".repeat(5461)],
  ];
  it.each(hostile)("removes the syntax of %s quickly", (_, markdown) => {
    const durations = Array.from({ length: 5 }, () => {
      const start = performance.now();
      readmeExcerpt(markdown);
      return performance.now() - start;
    });
    expect(Math.min(...durations)).toBeLessThan(50);
  });
});
