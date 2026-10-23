// The schema of a bookmark's prose enrichment (#124): what EnrichmentV1 accepts and rejects, and
// that the JSON Schema sent for structured output agrees with it. See "LLM enrichment output" in
// plans/haystack-v1-implementation-plan.md.
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";
import {
  ENRICHMENT_CAPS,
  ENRICHMENT_JSON_SCHEMA,
  EnrichmentV1,
  type JsonSchema,
} from "../src/enrichment/enrichment-schema.ts";
import { VALID_OUTPUT } from "./enrichment-output.ts";

function accepts(value: unknown): boolean {
  return v.safeParse(EnrichmentV1, value).success;
}

describe("EnrichmentV1", () => {
  it("accepts a valid output", () => {
    expect(accepts(VALID_OUTPUT)).toBe(true);
  });

  it("accepts an output whose use_cases list is empty", () => {
    expect(accepts({ ...VALID_OUTPUT, use_cases: [] })).toBe(true);
  });

  it("accepts an output whose every list is empty", () => {
    expect(
      accepts({
        summary: "A page titled Untitled.",
        use_cases: [],
        problems_solved: [],
        technologies: [],
        topics: [],
        alternative_terms: [],
      }),
    ).toBe(true);
  });

  it("accepts each field at its cap", () => {
    expect(
      accepts({
        summary: "s".repeat(ENRICHMENT_CAPS.summary),
        use_cases: Array(ENRICHMENT_CAPS.sentences).fill("u".repeat(ENRICHMENT_CAPS.sentence)),
        problems_solved: Array(ENRICHMENT_CAPS.sentences).fill(
          "p".repeat(ENRICHMENT_CAPS.sentence),
        ),
        technologies: Array(ENRICHMENT_CAPS.terms).fill("t".repeat(ENRICHMENT_CAPS.term)),
        topics: Array(ENRICHMENT_CAPS.terms).fill("t".repeat(ENRICHMENT_CAPS.term)),
        alternative_terms: Array(ENRICHMENT_CAPS.terms).fill("a".repeat(ENRICHMENT_CAPS.term)),
      }),
    ).toBe(true);
  });

  const overCap: [string, object][] = [
    ["a summary over 280 characters", { summary: "s".repeat(281) }],
    ["a use case over 160 characters", { use_cases: ["u".repeat(161)] }],
    ["a problem over 160 characters", { problems_solved: ["p".repeat(161)] }],
    ["a technology over 40 characters", { technologies: ["t".repeat(41)] }],
    ["a topic over 40 characters", { topics: ["t".repeat(41)] }],
    ["an alternative term over 40 characters", { alternative_terms: ["a".repeat(41)] }],
    ["7 use cases", { use_cases: Array(7).fill("Use when you need to test.") }],
    ["7 problems", { problems_solved: Array(7).fill("Slow tests.") }],
    ["13 technologies", { technologies: Array(13).fill("TypeScript") }],
    ["13 topics", { topics: Array(13).fill("testing") }],
    ["13 alternative terms", { alternative_terms: Array(13).fill("test runner") }],
  ];
  for (const [name, change] of overCap) {
    it(`rejects ${name}`, () => {
      expect(accepts({ ...VALID_OUTPUT, ...change })).toBe(false);
    });
  }

  for (const field of Object.keys(VALID_OUTPUT)) {
    it(`rejects an output without ${field}`, () => {
      const { [field as keyof typeof VALID_OUTPUT]: _, ...rest } = VALID_OUTPUT;
      expect(accepts(rest)).toBe(false);
    });
  }

  it("rejects an output with a key the schema doesn't name", () => {
    expect(accepts({ ...VALID_OUTPUT, relevance: "every query" })).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "summary"],
    ["a list entry that isn't a string", { ...VALID_OUTPUT, topics: [42] }],
    ["a summary that isn't a string", { ...VALID_OUTPUT, summary: ["A test runner."] }],
  ])("rejects %s", (_, value) => {
    expect(accepts(value)).toBe(false);
  });
});

// Keywords Anthropic's structured outputs reject with a 400 ("JSON Schema limitations", read on
// 2026-10-23), and `$schema`, which only names the draft. EnrichmentV1 enforces the caps instead.
const UNSENT_KEYWORDS = new Set(["$schema", "maxLength", "maxItems"]);

// The schema without `keywords`, at every level.
function without(schema: unknown, keywords: ReadonlySet<string>): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => without(item, keywords));
  }
  if (typeof schema === "object" && schema !== null) {
    return Object.fromEntries(
      Object.entries(schema)
        .filter(([keyword]) => !keywords.has(keyword))
        .map(([keyword, value]) => [keyword, without(value, keywords)]),
    );
  }
  return schema;
}

// Every keyword used anywhere in the schema, property names excluded.
function keywords(schema: unknown, found = new Set<string>()): Set<string> {
  if (typeof schema === "object" && schema !== null && !Array.isArray(schema)) {
    for (const [keyword, value] of Object.entries(schema)) {
      if (keyword === "properties") {
        for (const property of Object.values(value as object)) {
          keywords(property, found);
        }
      } else {
        found.add(keyword);
        keywords(value, found);
      }
    }
  }
  return found;
}

// The cap that the generated schema sets with `keyword`. Every field has one.
function cap(schema: unknown, keyword: "maxLength" | "maxItems"): number {
  const value: unknown = (schema as JsonSchema)[keyword];
  if (typeof value !== "number") {
    throw new TypeError(`The generated schema has no ${keyword}`);
  }
  return value;
}

describe("ENRICHMENT_JSON_SCHEMA", () => {
  const generated = toJsonSchema(EnrichmentV1);

  it("is what @valibot/to-json-schema generates from EnrichmentV1, without the caps", () => {
    expect(without(ENRICHMENT_JSON_SCHEMA, new Set(["description"]))).toEqual(
      without(generated, UNSENT_KEYWORDS),
    );
  });

  it("states each of EnrichmentV1's caps in a description", () => {
    const properties = generated.properties as Record<string, JsonSchema>;
    const sent = ENRICHMENT_JSON_SCHEMA.properties as Record<string, JsonSchema>;
    for (const [name, property] of Object.entries(properties)) {
      const sentProperty = sent[name] ?? {};
      if (property.type === "array") {
        expect(sentProperty.description).toContain(`At most ${cap(property, "maxItems")} entries.`);
        expect((sentProperty.items as JsonSchema).description).toContain(
          `At most ${cap(property.items, "maxLength")} characters.`,
        );
      } else {
        expect(sentProperty.description).toContain(
          `At most ${cap(property, "maxLength")} characters.`,
        );
      }
    }
  });

  it("uses only keywords that structured outputs support", () => {
    // From "JSON Schema limitations": the types, `required`, `additionalProperties` (false), and
    // `description`, which every JSON Schema allows. `items` is how an array names its entries.
    expect([...keywords(ENRICHMENT_JSON_SCHEMA)].sort()).toEqual(
      ["additionalProperties", "description", "items", "required", "type"].sort(),
    );
    expect(ENRICHMENT_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});
