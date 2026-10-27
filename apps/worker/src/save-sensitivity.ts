// The save form's sensitivity check (#132): Jev's probability that the link gives access to
// something private, asked on the signed-in GET /save and asked again on POST /save. See "On the
// save form" and "Calibration" under "Probabilistic check with Jev" in
// plans/haystack-v1-implementation-plan.md.
//
// The rules:
// - Jev gets describeUrlForJudgment's description, never the URL, as the enrichment gate's check
//   does (enrich-bookmark.ts), and from the same inputs, so a bookmark gets the same description
//   from either check: the address that is saved, without its tracking parameters; the page's own
//   title (the payload's `title`, which `captured_title` stores), not the title the user
//   confirms; and the flag that the page declared a canonical URL that detectSensitiveUrl
//   flagged.
// - A noul at or above SENSITIVE_WARN_THRESHOLD is a warning, never a refusal.
// - The check never blocks saving. Jev gets one attempt of SAVE_CHECK_TIMEOUT_MS, and a timeout,
//   any other failure, and a configuration that can't be read all give no answer: the form shows
//   no warning, the bookmark is saved with its noul left empty, and the enrichment gate checks it
//   later, with the sweep's retries.
// - The logs hold fixed codes and the noul only, never the URL, the title or anything from them.
import { describeUrlForJudgment } from "@haystack/schemas";
import { JEV_BACKOFF_INITIAL_MS, type JevConfig, type JevTiming } from "./enrichment/jev-client.ts";
import { askSensitivity } from "./enrichment/jev-questions.ts";
import {
  readSensitiveWarnThreshold,
  type SensitiveWarnThresholdConfig,
} from "./enrichment/state.ts";
import { errorCode } from "./error-code.ts";

/** The configuration the check reads. `Env` has it, from `vars` and `secrets.required`. */
export type SaveSensitivityConfig = JevConfig & SensitiveWarnThresholdConfig;

/**
 * How long the check may take, from the request to the last byte of Jev's answer. The page waits
 * for it, so it is short: the documentation's examples answer in a fraction of a second (the
 * parallel questions cookbook answers 13 questions in 0.27 seconds), and the enrichment
 * questions' 5 seconds per attempt is for a sweep that nobody waits on.
 */
export const SAVE_CHECK_TIMEOUT_MS = 2000;

// One attempt, because a retry would add a backoff and a second wait to a page the user is
// waiting for. A failed check costs nothing that can't be made up: the gate asks again later.
const SAVE_CHECK_TIMING: JevTiming = {
  attemptTimeoutMs: SAVE_CHECK_TIMEOUT_MS,
  backoffInitialMs: JEV_BACKOFF_INITIAL_MS,
  attemptLimit: 1,
};

/** Jev's answer, with what it means for the form, or no answer at all. */
export type SensitivityCheck =
  | {
      readonly answered: true;
      readonly noul: number;
      // When the answer arrived, which POST /save stores as `sensitivity_checked_at`.
      readonly checkedAt: number;
      // At or above SENSITIVE_WARN_THRESHOLD: the form warns and asks for the checkbox.
      readonly warns: boolean;
    }
  | { readonly answered: false };

const NO_ANSWER: SensitivityCheck = { answered: false };

/**
 * Asks Jev whether the link the form saves gives access to something private. `url` is the
 * address that is saved, with tracking parameters removed, and `title` is the payload's `title`.
 * `declaresSensitiveCanonical` is whether the page declared a canonical URL that
 * detectSensitiveUrl flagged. Resolves to no answer, having logged why, rather than throwing for
 * a failure or a configuration error, because the check must never block saving.
 */
export async function checkSaveSensitivity(
  config: SaveSensitivityConfig,
  url: string,
  title: string | undefined,
  declaresSensitiveCanonical: boolean,
): Promise<SensitivityCheck> {
  let threshold: number;
  let result;
  try {
    threshold = readSensitiveWarnThreshold(config);
    result = await askSensitivity(
      config,
      describeUrlForJudgment(new URL(url), title, declaresSensitiveCanonical),
      SAVE_CHECK_TIMING,
    );
  } catch (error) {
    // A threshold that can't be read, an empty key or a base URL that isn't valid. The sweep
    // stops for the same error, so it is found there too, and saving goes on without the check.
    console.warn("Sensitivity check skipped:", errorCode(error));
    return NO_ANSWER;
  }
  if (!result.ok) {
    const { reason, status } = result;
    console.warn(
      "Sensitivity check skipped:",
      status === undefined ? reason : `${reason}:${status}`,
    );
    return NO_ANSWER;
  }
  return {
    answered: true,
    noul: result.answer,
    checkedAt: Date.now(),
    warns: result.answer >= threshold,
  };
}

/**
 * Logs that the form showed the warning, for the calibration: how often the warning fires, which
 * the saved bookmarks' nouls and acknowledgments can be compared with. Only the noul is logged,
 * never the URL or anything from it.
 */
export function logWarningShown(noul: number): void {
  console.info("Sensitivity warning shown:", { noul });
}
