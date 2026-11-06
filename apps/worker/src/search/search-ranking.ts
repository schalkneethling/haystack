// Ranking a search's answers (#212). See "Ranking and thresholds" in
// plans/haystack-v1-implementation-plan.md.
//
// The display signal ranks the answers, highest first, and only those at or above that signal's
// threshold are shown. The other signal's list, at or above its own threshold, is not shown: the
// search service counts it in its log line, and a replay rebuilds it from `search_answers` and
// the run's thresholds. The two signals are on different scales and mean different things (a Noul
// is a probability of yes, a Score a position on four levels), so neither ever ranks or breaks a
// tie for the other.
import {
  SEARCH_DISPLAY_SIGNAL_FLAG,
  SEARCH_QUESTIONS_FLAG,
  type SearchSettings,
} from "../flags.ts";
import type { BookmarkAnswers } from "./jev-search.ts";

/** A signal that can rank the results: the `search_runs.display_signal` column. */
export type DisplaySignal = SearchSettings["displaySignal"];

/**
 * The settings a search uses. They are the settings given, unless the questions leave out the
 * display signal, as `search-questions` set to `noul` with `search-display-signal` set to `score`
 * does: then the signal that was asked ranks the results, and the run records it as its display
 * signal (#212). Asking both questions instead would spend the batch capacity that narrowing the
 * questions is meant to give back, and failing the search would let one mistyped flag stop search
 * altogether. The warning names the two flags and never their values, as flags.ts's warnings do.
 */
export function usedSearchSettings(settings: SearchSettings): SearchSettings {
  if (settings.questions === "both" || settings.questions === settings.displaySignal) {
    return settings;
  }
  console.warn("Search settings disagree, ranking by the asked signal:", {
    flags: [SEARCH_QUESTIONS_FLAG, SEARCH_DISPLAY_SIGNAL_FLAG],
  });
  return { ...settings, displaySignal: settings.questions };
}

// The answer's value for the signal, or null when its question wasn't asked.
function signalValue(answer: BookmarkAnswers, signal: DisplaySignal): number | null {
  return signal === "noul" ? answer.noul : (answer.score?.score ?? null);
}

function thresholdOf(settings: SearchSettings, signal: DisplaySignal): number {
  return signal === "noul" ? settings.noulThreshold : settings.scoreThreshold;
}

/**
 * The answers whose value for `signal` is at or above that signal's threshold, in the order
 * given. An answer without that signal, because its question wasn't asked, is never one of them.
 */
export function signalMatches(
  answers: readonly BookmarkAnswers[],
  settings: SearchSettings,
  signal: DisplaySignal,
): readonly BookmarkAnswers[] {
  const threshold = thresholdOf(settings, signal);
  return answers.filter((answer) => {
    const value = signalValue(answer, signal);
    return value !== null && value >= threshold;
  });
}

/**
 * The IDs of the answers to show, in their order: those at or above the display signal's
 * threshold, the highest value first. Equal values put the bookmark saved more recently first,
 * `savedAt` giving each bookmark's `created_at`, because between two equally good answers the
 * newer save is the likelier one to be looked for, and then the lower ID, so that the order never
 * depends on the order Jev's chunks came back in, and a replay gets the same order (#212).
 */
export function rankAnswers(
  answers: readonly BookmarkAnswers[],
  settings: SearchSettings,
  savedAt: (bookmarkId: string) => number,
): readonly string[] {
  const signal = settings.displaySignal;
  return signalMatches(answers, settings, signal)
    .map((answer) => ({
      id: answer.bookmarkId,
      // signalMatches keeps only answers that have the signal.
      value: signalValue(answer, signal) ?? 0,
      savedAt: savedAt(answer.bookmarkId),
    }))
    .toSorted(
      (a, b) =>
        b.value - a.value || b.savedAt - a.savedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map(({ id }) => id);
}
