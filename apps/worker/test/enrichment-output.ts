// Evidence and LLM output for the prose enrichment's tests (#124): a GitHub repository bookmark,
// the input the LLM is given about it, and an output that EnrichmentV1 accepts.
import type { EnrichmentInput } from "../src/enrichment/enrichment-prompt.ts";
import type { EnrichmentV1 } from "../src/enrichment/enrichment-schema.ts";

/** A bookmark of a test runner's repository, with what GitHub says about it. */
export const REPOSITORY_INPUT: EnrichmentInput = {
  bookmark: {
    url: "https://github.com/vitest-dev/vitest",
    title: "vitest-dev/vitest: Next generation testing framework powered by Vite.",
    captured_title: "vitest-dev/vitest: Next generation testing framework powered by Vite.",
    og_site_name: "GitHub",
  },
  kind: "tool",
  github: {
    repository: "vitest-dev/vitest",
    bookmark_is: "the repository",
    description: "Next generation testing framework powered by Vite.",
    topics: ["test", "testing-tools", "vite"],
    language: "TypeScript",
    readme_excerpt: "Vitest\nNext generation testing framework powered by Vite.",
  },
};

/** An output that EnrichmentV1 accepts, for REPOSITORY_INPUT. */
export const VALID_OUTPUT: EnrichmentV1 = {
  summary: "Vitest is a testing framework for JavaScript and TypeScript projects built on Vite.",
  use_cases: [
    "Use when you need to run unit tests in a Vite project.",
    "Use when you need a fast test runner for TypeScript.",
  ],
  problems_solved: ["Tests that are slow to start in a Vite project."],
  technologies: ["TypeScript", "Vite"],
  topics: ["testing", "test runners"],
  alternative_terms: ["test runner", "unit testing framework"],
};
