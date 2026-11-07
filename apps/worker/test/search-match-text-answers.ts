// Jev's answers to a search, for the tests that search a few bookmarks (search-bookmarks.test.ts,
// search-api.test.ts): each bookmark's signals are looked up by its `match_text`, which a test sets
// to a name of its own, so a test says which bookmark Jev ranks how.
import { HttpResponse } from "msw";
import type { JevResolver } from "./jev-fixture.ts";

/** The model the fixture says answered. A test configures another, to see which a run records. */
export const ANSWERING_MODEL = "jev-1.14.0";

interface Signals {
  readonly noul: number;
  readonly score: number;
}

// Below both of the default thresholds, unless a test says otherwise.
const UNMATCHED: Signals = { noul: 0.1, score: 0.4 };

export const PROBABILITIES = { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.6 };

export interface SentBody {
  readonly model: string;
  readonly state: {
    readonly query: string;
    readonly bookmarks: Record<string, { readonly title: string; readonly match_text: string }>;
  };
  readonly questions: Record<string, { readonly type: string }>;
}

/**
 * Answers every question in the request, with each bookmark's signals from `signals`, by its
 * `match_text`, or UNMATCHED.
 */
export function answerBy(signals: Record<string, Signals> = {}): JevResolver {
  return async (request) => {
    const body = (await request.json()) as SentBody;
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      const alias = id.replace(/_(helps|relevance)$/u, "");
      const matchText = body.state.bookmarks[alias]?.match_text ?? "";
      const { noul, score } = signals[matchText] ?? UNMATCHED;
      answers[id] =
        question.type === "noul"
          ? { type: "noul", noul }
          : { type: "score", score, confidence: 0.41, probabilities: PROBABILITIES };
    }
    return HttpResponse.json({
      model: ANSWERING_MODEL,
      answers,
      usage: { input_tokens: 100 * Object.keys(body.state.bookmarks).length, output_tokens: 5 },
    });
  };
}
