// Jev's answers to the enrichment questions, in the shape of its recorded responses, for the tests
// that run the enrichment module (enrich-bookmark.test.ts) and the sweep (enrich-pending.test.ts).
import type { Kind } from "../src/enrichment/jev-questions.ts";
import { answer, type JevResolver } from "./jev-fixture.ts";

/** The `kind` answer's probabilities, which the enrichment row stores. */
export const PROBABILITIES = {
  tool: 0.81,
  library: 0.12,
  reference: 0.02,
  tutorial: 0.01,
  article: 0.01,
  discussion: 0.01,
  collection: 0.01,
  other: 0.01,
};

/** Jev's answer to the sensitivity question. */
export function noul(value: number): JevResolver {
  return answer({
    model: "jev-1.13.0",
    answers: { private_access: { type: "noul", noul: value } },
    usage: { input_tokens: 412, output_tokens: 9 },
  });
}

/** Jev's answer to the `kind` question. */
export function kind(choice: Kind = "tool"): JevResolver {
  return answer({
    model: "jev-1.13.0",
    answers: { kind: { type: "choice", choice, confidence: 0.7, probabilities: PROBABILITIES } },
    usage: { input_tokens: 655, output_tokens: 40 },
  });
}
