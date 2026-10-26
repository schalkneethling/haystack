// The configuration module (#128): the only code that reads the Flagship binding, FLAGS. See
// "Secrets and configuration", Q3 and Q13 in plans/haystack-v1-implementation-plan.md.
//
// Flags are the settings that change without a deploy (plan, decision 20). Each is read once per
// sweep run, with a constant key, and passed on, so the run sees one value throughout. Each
// flag's default is a constant here, so the defaults are reviewed in code. They are what a
// Flagship outage runs with, so they are the safe values.
//
// What the binding does (Q13): its typed getters return the default they are given for a missing
// flag, for one that can't be evaluated and for one of the wrong type, and they throw for an
// empty key and for any other error. So the keys are constant and non-empty, any error from the
// binding gives every default, and a value the getter returns is still checked here, because
// Flagship is an outside service whose answers are untrusted input (plan, "Testing strategy").
import { SWEEP_BATCH_SIZE, SWEEP_BATCH_SIZE_LIMIT } from "./enrichment/enrich-pending.ts";
import { errorCode } from "./error-code.ts";

/**
 * The part of the Flagship binding this module calls, with the getters' signatures from the
 * Workers types (`Flagship` in worker-configuration.d.ts), less the evaluation context, which
 * Haystack doesn't pass. It is written out, not picked from `Flagship`, because the tests' Node
 * program doesn't include the Workers types, and a test types its fake binding with it. The real
 * binding must still fit it: index.ts passes `env` to runScheduled, which takes a FlagReader, so
 * a change to the binding's getters that this no longer matches fails the type check there.
 */
export interface FlagReader {
  getBooleanValue(flagKey: string, defaultValue: boolean): Promise<boolean>;
  getNumberValue(flagKey: string, defaultValue: number): Promise<number>;
}

/**
 * Whether the scheduled run enriches bookmarks: a boolean flag. The owner turns it off in the
 * Flagship app, under this key, to stop the sweep without a deploy. It stops only the sweep: the
 * scheduled run still deletes expired sessions and sign-in flows (scheduled.ts).
 */
export const SWEEP_ENABLED_FLAG = "sweep-enabled";

/**
 * How many bookmarks one sweep run enriches: a number flag, a whole number from 1 to
 * SWEEP_BATCH_SIZE_LIMIT (Q3's ceiling). It can be lowered without a deploy, for example when a
 * run comes close to its CPU limit (Q3).
 */
export const SWEEP_BATCH_SIZE_FLAG = "sweep-batch-size";

/** The sweep's switches, as one run uses them. */
export interface SweepFlags {
  readonly enabled: boolean;
  // A whole number from 1 to SWEEP_BATCH_SIZE_LIMIT.
  readonly batchSize: number;
}

/**
 * The defaults: the sweep enabled, because it is the retry mechanism for every failure, and Q3's
 * starting batch of 3, which is also its ceiling. The batch size must never be above the
 * ceiling, because a Flagship outage runs with it, and a fourth bookmark could take a run over
 * the subrequest limit.
 */
export const SWEEP_FLAG_DEFAULTS: SweepFlags = Object.freeze({
  enabled: true,
  batchSize: SWEEP_BATCH_SIZE,
});

// The live batch size, or the default for a value that isn't a whole number from 1 to the
// ceiling, such as 4, 0 or 2.5, so a mistyped flag can't take a run over the subrequest limit,
// or make enrichPending throw.
function checkedBatchSize(value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= SWEEP_BATCH_SIZE_LIMIT
  ) {
    return value;
  }
  console.warn("Flag ignored, using its default:", { flag: SWEEP_BATCH_SIZE_FLAG });
  return SWEEP_FLAG_DEFAULTS.batchSize;
}

// The live switch, or the default for a value that isn't a boolean, which the getter shouldn't
// return but which is untrusted input all the same.
function checkedEnabled(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  console.warn("Flag ignored, using its default:", { flag: SWEEP_ENABLED_FLAG });
  return SWEEP_FLAG_DEFAULTS.enabled;
}

/**
 * Reads the sweep's flags, once for the run. Never throws: an error from the binding gives every
 * default, and is logged by its code or name only, so a Flagship problem can't stop the
 * scheduled run (Q13). So does a binding that is missing, which `Env` can't rule out at runtime,
 * because the getters are called inside the same `try`. A value outside its range gives that
 * flag's default.
 */
export async function readSweepFlags(flags: FlagReader): Promise<SweepFlags> {
  let enabled: unknown;
  let batchSize: unknown;
  try {
    [enabled, batchSize] = await Promise.all([
      flags.getBooleanValue(SWEEP_ENABLED_FLAG, SWEEP_FLAG_DEFAULTS.enabled),
      flags.getNumberValue(SWEEP_BATCH_SIZE_FLAG, SWEEP_FLAG_DEFAULTS.batchSize),
    ]);
  } catch (error) {
    console.error("Flags unavailable, using the defaults:", { code: errorCode(error) });
    return SWEEP_FLAG_DEFAULTS;
  }
  return { enabled: checkedEnabled(enabled), batchSize: checkedBatchSize(batchSize) };
}
