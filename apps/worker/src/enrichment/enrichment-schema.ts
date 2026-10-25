// The prose fields the LLM writes about a bookmark, version 1 (#124). See "LLM enrichment output"
// in plans/haystack-v1-implementation-plan.md. The fields become `match_text`, which search asks
// Jev to judge, so each is capped, and no list has a minimum length: an empty list is the right
// answer when the evidence doesn't support an entry.
//
// Two schemas describe the output. EnrichmentV1 validates it, once, outside every adapter
// (enrichment-provider.ts). ENRICHMENT_JSON_SCHEMA is sent to the provider for structured output.
// Anthropic's structured outputs reject `maxLength` and `maxItems` with a 400
// (https://platform.claude.com/docs/en/build-with-claude/structured-outputs, "JSON Schema
// limitations", read on 2026-10-23), so the JSON Schema states each cap in its description, and
// only EnrichmentV1 enforces it. enrichment-schema.test.ts checks that the JSON Schema is what
// @valibot/to-json-schema generates from EnrichmentV1, without those two keywords, so the two
// can't drift apart.
import * as v from "valibot";

/**
 * The caps, in UTF-16 code units for a string, as Valibot's `maxLength` counts, and in entries
 * for a list. The prompt and the JSON Schema state the same numbers.
 */
export const ENRICHMENT_CAPS = {
  summary: 280,
  sentence: 160,
  sentences: 6,
  term: 40,
  terms: 12,
} as const;

// A list of at most `entries` strings of at most `length` code units each.
function list(length: number, entries: number) {
  return v.pipe(v.array(v.pipe(v.string(), v.maxLength(length))), v.maxLength(entries));
}

/**
 * The plan's EnrichmentV1, with one change: it is a strict object, so a key the schema doesn't
 * name fails validation instead of being dropped. The JSON Schema sent to the provider forbids
 * such keys (`additionalProperties: false`, which Anthropic requires), so the two agree.
 */
export const EnrichmentV1 = v.strictObject({
  summary: v.pipe(v.string(), v.maxLength(ENRICHMENT_CAPS.summary)),
  use_cases: list(ENRICHMENT_CAPS.sentence, ENRICHMENT_CAPS.sentences),
  problems_solved: list(ENRICHMENT_CAPS.sentence, ENRICHMENT_CAPS.sentences),
  technologies: list(ENRICHMENT_CAPS.term, ENRICHMENT_CAPS.terms),
  topics: list(ENRICHMENT_CAPS.term, ENRICHMENT_CAPS.terms),
  alternative_terms: list(ENRICHMENT_CAPS.term, ENRICHMENT_CAPS.terms),
});

export type EnrichmentV1 = v.InferOutput<typeof EnrichmentV1>;

/**
 * The `schema_version` that enrichment writes now, which EnrichmentV1 describes (#126). Raising
 * it makes every bookmark's enrichment Outdated, and the sweep enriches each one again, so it is
 * raised with a change to the output's shape (see "Enrichment state is derived, not stored" and
 * Phase 9 in the plan). Failure records are kept per version, so raising it also gives every
 * Failed bookmark a fresh set of attempts. The sweep's `match_text` refresh validates the rows at
 * this version against EnrichmentV1 (match-text-refresh.ts), so a new version, with a new shape,
 * must update the refresh too.
 */
export const ENRICHMENT_SCHEMA_VERSION = 1;

/** A JSON Schema, as the structured-output request carries it. */
export interface JsonSchema {
  readonly [keyword: string]: unknown;
}

function stringSchema(length: number): JsonSchema {
  return { type: "string", description: `At most ${length} characters.` };
}

function listSchema(length: number, entries: number): JsonSchema {
  return {
    type: "array",
    description: `At most ${entries} entries. An empty list when the evidence supports none.`,
    items: stringSchema(length),
  };
}

/**
 * The structured-output schema. Every field is required, so the model returns them in this
 * order (structured outputs put required properties first), and an empty list is how it says
 * "nothing".
 */
export const ENRICHMENT_JSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary: stringSchema(ENRICHMENT_CAPS.summary),
    use_cases: listSchema(ENRICHMENT_CAPS.sentence, ENRICHMENT_CAPS.sentences),
    problems_solved: listSchema(ENRICHMENT_CAPS.sentence, ENRICHMENT_CAPS.sentences),
    technologies: listSchema(ENRICHMENT_CAPS.term, ENRICHMENT_CAPS.terms),
    topics: listSchema(ENRICHMENT_CAPS.term, ENRICHMENT_CAPS.terms),
    alternative_terms: listSchema(ENRICHMENT_CAPS.term, ENRICHMENT_CAPS.terms),
  },
  required: [
    "summary",
    "use_cases",
    "problems_solved",
    "technologies",
    "topics",
    "alternative_terms",
  ],
  additionalProperties: false,
};
