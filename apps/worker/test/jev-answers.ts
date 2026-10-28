// Jev's answers to the enrichment questions, for the tests that run the enrichment module
// (enrich-bookmark.test.ts) and the sweep (enrich-pending.test.ts). They have the shape of the
// API reference's Noul and Choice answers (https://docs.typesafe.ai/api/system-one.md, read on
// 2026-10-28), which is the same for every model, and name the pinned model as the one that
// answered.
import type { Kind } from "../src/enrichment/jev-questions.ts";
import { answer, type JevResolver } from "./jev-fixture.ts";

/** The `kind` answer's probabilities when it is `tool`, which the enrichment row stores. */
export const PROBABILITIES = {
  tool: 0.81,
  library: 0.12,
  reference: 0.02,
  tutorial: 0.01,
  article: 0.01,
  discussion: 0.01,
  collection: 0.01,
  other: 0.01,
} satisfies Record<Kind, number>;

/**
 * PROBABILITIES with the highest probability on `choice`, which trades places with `tool`. The API
 * reference defines a Choice answer's `choice` as "the choice with the highest probability", so a
 * `kind` answer that put more on another option would be one Jev can't give.
 */
function probabilitiesFor(choice: Kind): Record<Kind, number> {
  return { ...PROBABILITIES, tool: PROBABILITIES[choice], [choice]: PROBABILITIES.tool };
}

/** Jev's answer to the sensitivity question. */
export function noul(value: number): JevResolver {
  return answer({
    model: "jev-1.14.0",
    answers: { private_access: { type: "noul", noul: value } },
    usage: { input_tokens: 412, output_tokens: 9 },
  });
}

/** Jev's answer to the `kind` question. */
export function kind(choice: Kind = "tool"): JevResolver {
  return answer({
    model: "jev-1.14.0",
    answers: {
      kind: { type: "choice", choice, confidence: 0.7, probabilities: probabilitiesFor(choice) },
    },
    usage: { input_tokens: 655, output_tokens: 40 },
  });
}
