import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";
import { SEARCH_QUERY_CAP, SearchAnswer, SearchQuery } from "../src/index.ts";

describe("SearchQuery", () => {
  it("trims the query", () => {
    expect(v.parse(SearchQuery, "  a tool for testing  ")).toBe("a tool for testing");
  });

  it(`accepts ${SEARCH_QUERY_CAP} characters and rejects one more`, () => {
    expect(v.safeParse(SearchQuery, "a".repeat(SEARCH_QUERY_CAP)).success).toBe(true);
    expect(v.safeParse(SearchQuery, "a".repeat(SEARCH_QUERY_CAP + 1)).success).toBe(false);
  });

  it("counts the length after trimming", () => {
    expect(v.safeParse(SearchQuery, ` ${"a".repeat(SEARCH_QUERY_CAP)} `).success).toBe(true);
  });

  it.each(["", "   ", "\n\t"])("rejects the empty query %j", (query) => {
    expect(v.safeParse(SearchQuery, query).success).toBe(false);
  });

  it("rejects a value that is not a string", () => {
    expect(v.safeParse(SearchQuery, 42).success).toBe(false);
  });
});

describe("SearchAnswer", () => {
  const result = {
    id: "b-1",
    title: "A guide",
    description: "How to do the thing.",
    url: "https://example.com/guide",
  };

  it("accepts a ranked list with the run's ID", () => {
    const answer = { runId: "r-1", results: [result, { ...result, id: "b-2", description: null }] };
    expect(v.parse(SearchAnswer, answer)).toEqual(answer);
  });

  it("accepts an answer with no results", () => {
    expect(v.safeParse(SearchAnswer, { runId: "r-1", results: [] }).success).toBe(true);
  });

  it.each([
    ["without the run's ID", { results: [result] }],
    ["without results", { runId: "r-1" }],
    ["with a result without an ID", { runId: "r-1", results: [{ ...result, id: undefined }] }],
    [
      "with a missing description",
      { runId: "r-1", results: [{ ...result, description: undefined }] },
    ],
    ["with a title that is not a string", { runId: "r-1", results: [{ ...result, title: 1 }] }],
  ])("rejects an answer %s", (_, answer) => {
    expect(v.safeParse(SearchAnswer, answer).success).toBe(false);
  });
});
