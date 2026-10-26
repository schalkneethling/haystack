// The Worker's scheduled run (#128), which the Cron Trigger in wrangler.jsonc starts every 5
// minutes: the enrichment sweep, then the deletion of expired sessions and sign-in flows. See
// "Enrichment sweep", "Secrets and configuration" and Phase 8 in
// plans/haystack-v1-implementation-plan.md.
//
// A run, in order:
// 1. Reads the configuration: the sweep's flags (flags.ts) and the attempt limit's `var`.
// 2. Runs the sweep (enrichPending) when its flag is on and the attempt limit can be read.
// 3. Deletes the sessions and the sign-in flows that have expired.
//
// The cleanup has nothing to do with enrichment, so it runs whatever happened to the sweep: when
// the flag turned it off, when it stopped early (its summary's `stopped`), and when it threw.
// Turning enrichment off must not keep old sessions in the database.
//
// What failed is logged by step and code only, never a message, which can hold a value from the
// configuration or a query (error-code.ts). The sweep logs its own summary and errors, which hold
// no URL, title or message either. When the sweep or the cleanup threw, the run throws at the
// end, with those codes alone, so the invocation's outcome is an exception that the dashboard
// and the tail show, rather than an `ok` that hides it.
import { deleteExpiredAuthFlows } from "./auth/auth-flows.ts";
import { deleteExpiredSessions } from "./auth/sessions.ts";
import { createDb } from "./db/client.ts";
import type { EnrichmentConfig } from "./enrichment/enrich-bookmark.ts";
import { enrichPending, type SweepSummary } from "./enrichment/enrich-pending.ts";
import { configurationError } from "./enrichment/configuration.ts";
import { errorCode } from "./error-code.ts";
import { type FlagReader, readSweepFlags, SWEEP_ENABLED_FLAG } from "./flags.ts";

/** The configuration the attempt limit is read from. `Env` has it, from `vars`. */
export interface SweepAttemptLimitConfig {
  // A whole number from 1, as a string, because every `var` is one.
  SWEEP_ATTEMPT_LIMIT: string;
}

/** What a scheduled run reads. `Env` has all of it. */
export interface ScheduledEnv extends EnrichmentConfig, SweepAttemptLimitConfig {
  // The binding createDb takes, D1Database, named through it so that this module names no
  // Workers type of its own, which the tests' Node program doesn't have.
  readonly DB: Parameters<typeof createDb>[0];
  readonly FLAGS: FlagReader;
}

// A whole number from 1, written out in decimal digits. Number() would also read `""` as 0,
// `0x5` as 5 and ` 3 ` as 3.
const ATTEMPT_LIMIT = /^[1-9]\d*$/;

/**
 * SWEEP_ATTEMPT_LIMIT as a number: how many attempts leave a bookmark Failed. Throws for any
 * other value. It is a `var`, so a wrong value is a configuration error that a reviewed deploy
 * shipped, and it is never replaced by a default: a guessed limit would change which bookmarks
 * end up Failed without anyone choosing it, as a guessed threshold would change which are Held
 * (readSensitiveWarnThreshold).
 */
export function readSweepAttemptLimit({
  SWEEP_ATTEMPT_LIMIT: value,
}: SweepAttemptLimitConfig): number {
  // The value can be missing, although `Env` says `string`, when a test's configuration leaves
  // it out.
  if (
    typeof value !== "string" ||
    !ATTEMPT_LIMIT.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw configurationError(
      `SWEEP_ATTEMPT_LIMIT is ${JSON.stringify(value)}, which isn't a whole number from 1`,
      "SWEEP_ATTEMPT_LIMIT_INVALID",
    );
  }
  return Number(value);
}

/** How many expired rows the cleanup deleted. */
export interface CleanupCounts {
  readonly sessions: number;
  readonly authFlows: number;
}

/** What a run did, for its caller. Each is null when that step didn't run or threw. */
export interface ScheduledResult {
  readonly sweep: SweepSummary | null;
  readonly cleanup: CleanupCounts | null;
}

/** The step that failed, and its code, which is safe to log. */
interface StepFailure {
  readonly step: "sweep" | "cleanup";
  readonly code: string;
}

function failed(step: StepFailure["step"], error: unknown): StepFailure {
  const failure = { step, code: errorCode(error) };
  console.error("Scheduled run error:", failure);
  return failure;
}

/**
 * Runs the sweep when its flag is on, then deletes the expired sessions and sign-in flows, and
 * resolves to what each did. The cleanup runs even when the sweep is off, stops early or throws.
 * Throws after the cleanup when either step threw, with only the steps and their codes in the
 * message.
 */
export async function runScheduled(env: ScheduledEnv): Promise<ScheduledResult> {
  const db = createDb(env.DB);
  const failures: StepFailure[] = [];

  let sweep: SweepSummary | null = null;
  const flags = await readSweepFlags(env.FLAGS);
  try {
    // Read whether or not the sweep runs, so a wrong limit is reported while the sweep is off,
    // before anyone turns it on.
    const attemptLimit = readSweepAttemptLimit(env);
    if (flags.enabled) {
      sweep = await enrichPending(db, env, { batchSize: flags.batchSize, attemptLimit });
    } else {
      // The flag's key only, so no log holds a flag's value.
      console.info("Enrichment sweep skipped:", { flag: SWEEP_ENABLED_FLAG });
    }
  } catch (error) {
    // A wrong SWEEP_ATTEMPT_LIMIT, or options enrichPending refuses. Its own errors are in its
    // summary instead.
    failures.push(failed("sweep", error));
  }

  let cleanup: CleanupCounts | null = null;
  try {
    // Measured after the sweep, which can take minutes, so nothing that expired meanwhile stays.
    const now = Date.now();
    cleanup = {
      sessions: await deleteExpiredSessions(db, now),
      authFlows: await deleteExpiredAuthFlows(db, now),
    };
    console.info("Expired rows deleted:", cleanup);
  } catch (error) {
    failures.push(failed("cleanup", error));
  }

  if (failures.length > 0) {
    const codes = failures.map(({ step, code }) => `${step}:${code}`).join(", ");
    throw new Error(`The scheduled run failed (${codes})`);
  }
  return { sweep, cleanup };
}
