// Ranking a search's answers (#212): which signal ranks them, which are shown, and how equal
// values are ordered. See "Ranking and thresholds" in plans/haystack-v1-implementation-plan.md.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  SEARCH_DISPLAY_SIGNAL_FLAG,
  SEARCH_QUESTIONS_FLAG,
  SEARCH_SETTING_DEFAULTS,
  type SearchSettings,
} from "../src/flags.ts";
import type { BookmarkAnswers } from "../src/search/jev-search.ts";
import { rankAnswers, signalMatches, usedSearchSettings } from "../src/search/search-ranking.ts";

const PROBABILITIES = { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.6 };

function answer(bookmarkId: string, noul: number | null, score: number | null): BookmarkAnswers {
  return {
    bookmarkId,
    noul,
    score: score === null ? null : { score, probabilities: PROBABILITIES, confidence: 0.5 },
  };
}

const settings: SearchSettings = {
  ...SEARCH_SETTING_DEFAULTS,
  noulThreshold: 0.5,
  scoreThreshold: 1.5,
};

// Every bookmark saved at the same time, unless a test says otherwise.
const sameTime = () => 1_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rankAnswers", () => {
  it("ranks by the display signal, highest first, and keeps those at or above its threshold", () => {
    const answers = [
      answer("low", 0.99, 0.4),
      answer("at", 0.1, 1.5),
      answer("high", 0.2, 2.9),
      answer("middle", 0.3, 2.1),
    ];
    expect(rankAnswers(answers, { ...settings, displaySignal: "score" }, sameTime)).toEqual([
      "high",
      "middle",
      "at",
    ]);
    expect(rankAnswers(answers, { ...settings, displaySignal: "noul" }, sameTime)).toEqual(["low"]);
  });

  it("puts the newer of two equal values first, and the lower ID when they were saved together", () => {
    const answers = [
      answer("b-older", null, 2),
      answer("d-same", null, 2),
      answer("a-newer", null, 2),
      answer("c-same", null, 2),
    ];
    const savedAt = (id: string) => ({ "b-older": 1, "a-newer": 3 })[id] ?? 2;
    expect(rankAnswers(answers, { ...settings, questions: "score" }, savedAt)).toEqual([
      "a-newer",
      "c-same",
      "d-same",
      "b-older",
    ]);
  });

  it("ignores the other signal when ranking, even to break a tie", () => {
    const answers = [answer("a", 0.1, 2), answer("b", 0.9, 2)];
    expect(rankAnswers(answers, settings, sameTime)).toEqual(["a", "b"]);
  });
});

describe("signalMatches", () => {
  it("lists the answers at or above a signal's own threshold, whichever signal is displayed", () => {
    const answers = [answer("a", 0.5, 0.1), answer("b", 0.49, 3), answer("c", 0.8, 1)];
    expect(signalMatches(answers, settings, "noul").map(({ bookmarkId }) => bookmarkId)).toEqual([
      "a",
      "c",
    ]);
  });

  it("lists nothing for a signal that wasn't asked", () => {
    const answers = [answer("a", null, 3)];
    expect(signalMatches(answers, settings, "noul")).toEqual([]);
  });
});

describe("usedSearchSettings", () => {
  it("keeps the settings when the display signal is asked", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const questions of ["both", "score"] as const) {
      const given: SearchSettings = { ...settings, questions, displaySignal: "score" };
      expect(usedSearchSettings(given)).toEqual(given);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("ranks by the asked signal when the questions leave out the display signal, and says so by flag", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(usedSearchSettings({ ...settings, questions: "noul", displaySignal: "score" })).toEqual({
      ...settings,
      questions: "noul",
      displaySignal: "noul",
    });
    expect(usedSearchSettings({ ...settings, questions: "score", displaySignal: "noul" })).toEqual({
      ...settings,
      questions: "score",
      displaySignal: "score",
    });
    // The flags' keys, and never their values.
    expect(warn.mock.calls).toEqual([
      [
        "Search settings disagree, ranking by the asked signal:",
        { flags: [SEARCH_QUESTIONS_FLAG, SEARCH_DISPLAY_SIGNAL_FLAG] },
      ],
      [
        "Search settings disagree, ranking by the asked signal:",
        { flags: [SEARCH_QUESTIONS_FLAG, SEARCH_DISPLAY_SIGNAL_FLAG] },
      ],
    ]);
  });
});
