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
    createdAt: Date.UTC(2026, 9, 1),
  };

  const valid = { runId: "r-1", outcome: "ok", results: [result] };

  it("accepts a ranked list with the run's ID", () => {
    const answer = { ...valid, results: [result, { ...result, id: "b-2", description: null }] };
    expect(v.parse(SearchAnswer, answer)).toEqual(answer);
  });

  // Some of Jev's chunks failed, so the results are those of the chunks that succeeded.
  it.each([
    ["with results", [result]],
    ["with none", []],
  ])("accepts a partial answer %s", (_, results) => {
    const answer = { ...valid, outcome: "partial", results };
    expect(v.parse(SearchAnswer, answer)).toEqual(answer);
  });

  it("accepts an ID as crypto.randomUUID() writes it", () => {
    const answer = { ...valid, results: [{ ...result, id: crypto.randomUUID() }] };
    expect(v.safeParse(SearchAnswer, answer).success).toBe(true);
  });

  // The page puts the ID into element IDs that an aria-labelledby list refers to, and such a list
  // is split on whitespace.
  it.each(["", "a b", "a\tb", "a\nb", " a", "a<b", 'a"b'])("rejects the result ID %j", (id) => {
    const answer = { ...valid, results: [{ ...result, id }] };
    expect(v.safeParse(SearchAnswer, answer).success).toBe(false);
  });

  it("accepts an answer with no results", () => {
    expect(v.safeParse(SearchAnswer, { ...valid, results: [] }).success).toBe(true);
  });

  // A search whose every chunk failed is answered with an error status (#214), never as an
  // answer with no results, which would read as "nothing matches".
  it.each([
    ["without the run's ID", { ...valid, runId: undefined }],
    ["without results", { ...valid, results: undefined }],
    ["without an outcome", { ...valid, outcome: undefined }],
    ["with the failed outcome", { ...valid, outcome: "failed", results: [] }],
    ["with an unknown outcome", { ...valid, outcome: "complete" }],
    ["with a result without an ID", { ...valid, results: [{ ...result, id: undefined }] }],
    ["with a missing description", { ...valid, results: [{ ...result, description: undefined }] }],
    ["with a title that is not a string", { ...valid, results: [{ ...result, title: 1 }] }],
    [
      "with a result without its saved time",
      { ...valid, results: [{ ...result, createdAt: undefined }] },
    ],
  ])("rejects an answer %s", (_, answer) => {
    expect(v.safeParse(SearchAnswer, answer).success).toBe(false);
  });

  // The page formats the saved time as a date, and a Date outside its range is invalid, so
  // formatting it would throw.
  it.each([
    ["a string", "1790000000000"],
    ["a fraction", 1.5],
    ["negative", -1],
    ["past the latest Date", 8.64e15 + 1],
    ["not a number", Number.NaN],
  ])("rejects a saved time that is %s", (_, createdAt) => {
    const answer = { ...valid, results: [{ ...result, createdAt }] };
    expect(v.safeParse(SearchAnswer, answer).success).toBe(false);
  });

  it("accepts the latest saved time a Date can hold", () => {
    const answer = { ...valid, results: [{ ...result, createdAt: 8.64e15 }] };
    expect(v.safeParse(SearchAnswer, answer).success).toBe(true);
  });
});
