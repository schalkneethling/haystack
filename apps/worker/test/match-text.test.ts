// The `match_text` derivation (#126). See "Match text" in plans/haystack-v1-implementation-plan.md
// and the header of src/enrichment/match-text.ts, which defines version 1.
import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";
import { EnrichmentV1 } from "../src/enrichment/enrichment-schema.ts";
import { deriveMatchText, MATCH_TEXT_VERSION } from "../src/enrichment/match-text.ts";
import { VALID_OUTPUT } from "./enrichment-output.ts";

const TITLE = "vitest-dev/vitest: Next generation testing framework powered by Vite.";

// An enrichment from thin evidence: every list is empty, as the prompt asks when the evidence
// supports no entry.
const THIN_OUTPUT: EnrichmentV1 = {
  summary: "A blog post about a release of a testing framework.",
  use_cases: [],
  problems_solved: [],
  technologies: [],
  topics: [],
  alternative_terms: [],
};

describe("deriveMatchText", () => {
  it("is version 1", () => {
    expect(MATCH_TEXT_VERSION).toBe(1);
  });

  it("has the title, kind, summary, use cases and alternative terms, in that order", () => {
    expect(deriveMatchText({ title: TITLE, kind: "tool", enrichment: VALID_OUTPUT })).toBe(
      [
        TITLE,
        "Kind: tool",
        "Vitest is a testing framework for JavaScript and TypeScript projects built on Vite.",
        "Use when you need to run unit tests in a Vite project.",
        "Use when you need a fast test runner for TypeScript.",
        "Other terms: test runner, unit testing framework",
      ].join("\n"),
    );
  });

  it("leaves out problems solved, technologies and topics", () => {
    const text = deriveMatchText({ title: TITLE, kind: "tool", enrichment: VALID_OUTPUT });
    for (const value of [
      ...VALID_OUTPUT.problems_solved,
      ...VALID_OUTPUT.technologies,
      ...VALID_OUTPUT.topics,
    ]) {
      expect(text.split("\n")).not.toContain(value);
    }
    expect(text).not.toContain("Tests that are slow to start");
    expect(text).not.toContain("test runners");
  });

  it("is the same text every time for the same enrichment", () => {
    const source = { title: TITLE, kind: "tool", enrichment: VALID_OUTPUT } as const;
    const first = deriveMatchText(source);
    expect(deriveMatchText(source)).toBe(first);
    // A copy of the same values, as the sweep reads them back from the stored JSON.
    expect(
      deriveMatchText({ ...source, enrichment: JSON.parse(JSON.stringify(VALID_OUTPUT)) }),
    ).toBe(first);
  });

  describe("an empty list", () => {
    it("passes validation, use_cases included", () => {
      expect(v.safeParse(EnrichmentV1, THIN_OUTPUT).success).toBe(true);
    });

    it("adds nothing, not even its label", () => {
      expect(
        deriveMatchText({ title: "Release notes", kind: "article", enrichment: THIN_OUTPUT }),
      ).toBe(
        [
          "Release notes",
          "Kind: article",
          "A blog post about a release of a testing framework.",
        ].join("\n"),
      );
    });

    it("leaves no placeholder for use cases", () => {
      const text = deriveMatchText({
        title: "Release notes",
        kind: "article",
        enrichment: { ...VALID_OUTPUT, use_cases: [] },
      });
      expect(text).not.toMatch(/use when|use cases?|none|n\/a|^$/imu);
      expect(text.split("\n")).toHaveLength(4);
    });
  });

  it("leaves out a value that is only whitespace, and an empty summary", () => {
    expect(
      deriveMatchText({
        title: "Release notes",
        kind: "article",
        enrichment: { ...THIN_OUTPUT, summary: "", use_cases: [" "], alternative_terms: ["\t"] },
      }),
    ).toBe("Release notes\nKind: article");
  });

  it("keeps each value on one line", () => {
    expect(
      deriveMatchText({
        title: "  Release\nnotes ",
        kind: "article",
        enrichment: {
          ...THIN_OUTPUT,
          summary: "A post\n\nabout a release.",
          use_cases: ["Use when you need to\nread release notes."],
          alternative_terms: ["change\nlog", "release notes"],
        },
      }),
    ).toBe(
      [
        "Release notes",
        "Kind: article",
        "A post about a release.",
        "Use when you need to read release notes.",
        "Other terms: change log, release notes",
      ].join("\n"),
    );
  });
});
