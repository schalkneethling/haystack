// The on-save path (#133): POST /save enriches the bookmark it has just inserted, inside
// `ctx.waitUntil`, so the "Saved" page doesn't wait for it. See "Enrichment sweep", "Jev client"
// and Q3 in plans/haystack-v1-implementation-plan.md.
//
// The rules:
// - It calls the same module as the sweep (enrichBookmark), with the row POST /save's insert
//   returned, so it reads no row. The module's gate asks Jev the sensitivity question only when
//   the save form's check got no answer, because POST /save stores the noul it got (#132).
// - It never rejects, so nothing escapes `ctx.waitUntil` as an unhandled rejection. An outcome
//   and a thrown error are both logged, with fixed codes, the elapsed time and never a URL, a
//   title or a message.
// - A failure leaves the bookmark to the sweep. A failed outcome is recorded as the sweep records
//   one, so the bookmark is Pending, and the sweep tries it again after its backoff window. A
//   thrown error, such as a configuration error or a rejected account, records nothing, and a
//   call that the runtime cuts short stores nothing it hadn't stored already, so either way the
//   bookmark is Pending, and the sweep's next run selects it.
// - Its time limits fit `ctx.waitUntil`'s 30 seconds (ON_SAVE_TIMING), so the module finishes,
//   and stores and logs its outcome, before the runtime would cancel it.
// - It has no switch yet: `sweep-enabled` (flags.ts) stops only the sweep, so until #199 is done,
//   switching it off doesn't stop this path.
import type { Db } from "../db/client.ts";
import {
  type BookmarkToEnrich,
  type EnrichmentConfig,
  type EnrichmentTiming,
  enrichBookmark,
  loggableError,
} from "./enrich-bookmark.ts";
import { GITHUB_TIMING } from "./github-client.ts";
import { JEV_BACKOFF_INITIAL_MS } from "./jev-client.ts";

/**
 * The time limits of the on-save path, which `ctx.waitUntil`'s 30 seconds after the response
 * bound. Cloudflare's "Context (ctx)" page (last updated 2026-10-12, read on 2026-10-28) gives
 * the 30 seconds, and says that promises still unsettled after them are cancelled.
 * The sweep's defaults would take up to 33 seconds for the two Jev questions alone, so these are
 * shorter, and the worst case for one bookmark is 27 seconds:
 *
 * - Jev: one attempt of 2.5 seconds per question, so no backoff and no `Retry-After` wait. The
 *   sensitivity question is asked only when the save form's check got no answer, and the `kind`
 *   question always: 5 seconds at most. The save form's check has one attempt of 2 seconds for a
 *   smaller state, and the documentation's examples answer in a fraction of a second.
 * - GitHub: its own limit of 3 seconds for each of its 2 requests, for a GitHub bookmark only: 6.
 * - The LLM: 8 seconds for each of its 2 calls, the second only after invalid or truncated
 *   output (writeProseEnrichment): 16. The sweep's LLM requests in #130 took at most 4.4 seconds
 *   on Workers Paid, the whole run's wall time, so 8 seconds is still about twice the longest.
 *
 * That leaves 3 seconds for the up to 3 D1 statements and the CPU time. A call that runs into a
 * limit fails transiently, which leaves the bookmark to the sweep, whose own limits are the
 * defaults (ENRICHMENT_TIMING).
 */
export const ON_SAVE_TIMING: EnrichmentTiming = {
  jev: { attemptTimeoutMs: 2500, backoffInitialMs: JEV_BACKOFF_INITIAL_MS, attemptLimit: 1 },
  github: GITHUB_TIMING,
  provider: { requestTimeoutMs: 8000 },
};

/**
 * Enriches a bookmark that POST /save has just inserted, with ON_SAVE_TIMING, and logs what
 * happened: `On-save enrichment:` with the outcome's codes and the elapsed time, or `On-save
 * enrichment error:` with a thrown error's codes (loggableError). Never rejects, so POST /save can
 * hand it to `ctx.waitUntil` as it is. The elapsed time is the Worker's clock, which the Workers
 * runtime moves on only while the Worker waits on I/O, so it is the time spent waiting on the
 * services and D1, which is what the 30 seconds are mostly spent on.
 */
export async function enrichOnSave(
  db: Db,
  config: EnrichmentConfig,
  bookmark: BookmarkToEnrich,
): Promise<void> {
  const started = Date.now();
  try {
    const outcome = await enrichBookmark(db, config, bookmark, ON_SAVE_TIMING);
    console.info("On-save enrichment:", { ...outcome, elapsedMs: Date.now() - started });
  } catch (error) {
    console.error("On-save enrichment error:", {
      ...loggableError(error),
      elapsedMs: Date.now() - started,
    });
  }
}
