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
        "See the guide and .",
        "Escaped *stars* stay, and so do <angle brackets> & entities.",
        "More Hidden details",
      ].join("\n"),
    );
  });

  it("is at most README_EXCERPT_LENGTH characters", () => {
    const long = Array.from({ length: 400 }, (_, index) => `Paragraph ${index} of prose.`).join(
      "\n\n",
    );
    const excerpt = readmeExcerpt(long);
    expect(excerpt.length).toBeLessThanOrEqual(README_EXCERPT_LENGTH);
    expect(excerpt.length).toBeGreaterThan(README_EXCERPT_LENGTH - 30);
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

  // Each of these is about 16 KiB, the client's read limit, of a construct that opens again and
  // again and never closes. Each takes under a millisecond. A pattern that scanned to the end
  // from every opening would take tens of milliseconds or more, so 50 ms catches that and
  // still leaves room for a slow machine.
  const hostile: [string, string][] = [
    ["unclosed links", "[a](".repeat(4096)],
    ["unclosed images", "![a](b ".repeat(2340)],
    ["unclosed emphasis", "**a ".repeat(4096)],
    ["unclosed underscores", " __a".repeat(4096)],
    ["unclosed inline code", "`a ".repeat(5461)],
    ["unclosed tags", "<a b='".repeat(2730)],
    ["unclosed script tags", "<script ".repeat(2048)],
    ["unclosed brackets", "[".repeat(16384)],
    ["nested parentheses", `[a](${"(".repeat(16380)}`],
    ["unclosed fences", "```\n~~~~\n".repeat(1820)],
  ];
  it.each(hostile)("removes the syntax of %s quickly", (_, markdown) => {
    const start = performance.now();
    readmeExcerpt(markdown);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
