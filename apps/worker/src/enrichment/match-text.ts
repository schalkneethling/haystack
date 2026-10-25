// The text that search asks Jev to judge a bookmark by (#126). See "Match text" and "Enrichment
// sweep" in plans/haystack-v1-implementation-plan.md. It is derived in code from the bookmark's
// title, its `kind` and its stored enrichment, never by the LLM, so the derivation can change and
// be applied to every enrichment again without calling the LLM or Jev: the sweep (#127) rewrites
// `match_text` from the stored `data` when MATCH_TEXT_VERSION is raised. It is a pure function of
// what is stored, so it gives the same text every time.
//
// Version 1 is one line for each of these, in this order, joined with line feeds:
// 1. the bookmark's title, as the user confirmed it on the save form (`bookmarks.title`);
// 2. `Kind: ` and the kind;
// 3. the summary;
// 4. each use case, in the order the LLM wrote them, which each start "Use when you need to";
// 5. `Other terms: ` and the alternative terms, in their order, joined with `, `.
//
// Whitespace in each value is collapsed to single spaces, so a value can't add a line of its own,
// and a value that is then empty is left out. An empty list adds nothing, not even its label, so
// the text never holds placeholder text for something the evidence didn't support.
// `technologies`, `topics` and `problems_solved` are left out, as the plan's hypothesis says, and
// Phase 12 compares a derivation that includes them.
import type { EnrichmentV1 } from "./enrichment-schema.ts";
import type { Kind } from "./jev-questions.ts";

/** The derivation that `deriveMatchText` implements, for the row's `match_text_version`. */
export const MATCH_TEXT_VERSION = 1;

/** What `match_text` is derived from: all of it is stored, so it can be derived again. */
export interface MatchTextSource {
  readonly title: string;
  readonly kind: Kind;
  readonly enrichment: EnrichmentV1;
}

// The value on one line, or an empty string.
function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** The bookmark's `match_text`, by derivation MATCH_TEXT_VERSION. */
export function deriveMatchText({ title, kind, enrichment }: MatchTextSource): string {
  const terms = enrichment.alternative_terms.map(oneLine).filter((term) => term !== "");
  return [
    oneLine(title),
    `Kind: ${kind}`,
    oneLine(enrichment.summary),
    ...enrichment.use_cases.map(oneLine),
    terms.length === 0 ? "" : `Other terms: ${terms.join(", ")}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
