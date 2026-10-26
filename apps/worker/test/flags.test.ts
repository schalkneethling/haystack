// The configuration module (#128), with a fake Flagship binding. The test harness can't set a
// flag (Q13 in plans/haystack-v1-implementation-plan.md), so these are unit tests. The fake
// answers as the binding's typed getters do: the flag's value when it has one, and otherwise the
// default it was given, as for a missing flag. scheduled.test.ts shows what the scheduled run
// does with the values.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SWEEP_BATCH_SIZE_LIMIT } from "../src/enrichment/enrich-pending.ts";
import {
  type FlagReader,
  readSweepFlags,
  SWEEP_BATCH_SIZE_FLAG,
  SWEEP_ENABLED_FLAG,
  SWEEP_FLAG_DEFAULTS,
} from "../src/flags.ts";

/** A fake binding with these flags set, and every key it was asked for. */
function fakeFlags(values: Record<string, unknown>): FlagReader & { readonly keys: string[] } {
  const keys: string[] = [];
  const read = async <T>(key: string, defaultValue: T): Promise<T> => {
    keys.push(key);
    return Object.hasOwn(values, key) ? (values[key] as T) : defaultValue;
  };
  return { keys, getBooleanValue: read, getNumberValue: read };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readSweepFlags", () => {
  it("reads each flag's value", async () => {
    const flags = fakeFlags({ [SWEEP_ENABLED_FLAG]: false, [SWEEP_BATCH_SIZE_FLAG]: 2 });

    expect(await readSweepFlags(flags)).toEqual({ enabled: false, batchSize: 2 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads each flag once, by its constant key", async () => {
    const flags = fakeFlags({});

    await readSweepFlags(flags);

    expect(flags.keys.toSorted()).toEqual(["sweep-batch-size", "sweep-enabled"]);
  });

  it("gives the defaults for missing flags: the sweep enabled, with a batch of 3", async () => {
    expect(await readSweepFlags(fakeFlags({}))).toEqual({ enabled: true, batchSize: 3 });
    expect(SWEEP_FLAG_DEFAULTS.batchSize).toBeLessThanOrEqual(SWEEP_BATCH_SIZE_LIMIT);
  });

  it("gives every default when the binding throws", async () => {
    // The switch's getter answers, but the batch size's throws, as the binding does for any
    // error other than a missing flag or a type mismatch (Q13).
    const flags: FlagReader = {
      getBooleanValue: async () => false,
      getNumberValue: async () => {
        throw Object.assign(new Error("Flagship is unavailable"), { name: "FlagshipError" });
      },
    };

    expect(await readSweepFlags(flags)).toEqual({ enabled: true, batchSize: 3 });
    expect(error).toHaveBeenCalledWith("Flags unavailable, using the defaults:", {
      code: "FlagshipError",
    });
  });

  it("gives every default when the binding is missing", async () => {
    // `Env` says the binding is there, but a configuration without it would bind nothing.
    const missing = undefined as unknown as FlagReader;

    expect(await readSweepFlags(missing)).toEqual({ enabled: true, batchSize: 3 });
  });

  it.each([4, 0, 2.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "replaces a batch size of %s with the default of 3",
    async (batchSize) => {
      const flags = fakeFlags({ [SWEEP_BATCH_SIZE_FLAG]: batchSize });

      expect(await readSweepFlags(flags)).toEqual({ enabled: true, batchSize: 3 });
      expect(warn).toHaveBeenCalledWith("Flag ignored, using its default:", {
        flag: SWEEP_BATCH_SIZE_FLAG,
      });
    },
  );

  it.each([1, 2, 3])("keeps a batch size of %s", async (batchSize) => {
    const flags = fakeFlags({ [SWEEP_BATCH_SIZE_FLAG]: batchSize });

    expect((await readSweepFlags(flags)).batchSize).toBe(batchSize);
  });

  it.each(["3", null, true])("replaces a batch size that isn't a number (%s)", async (value) => {
    const flags = fakeFlags({ [SWEEP_BATCH_SIZE_FLAG]: value });

    expect((await readSweepFlags(flags)).batchSize).toBe(3);
  });

  it.each(["false", 0, null])("replaces a switch that isn't a boolean (%s)", async (value) => {
    const flags = fakeFlags({ [SWEEP_ENABLED_FLAG]: value });

    expect((await readSweepFlags(flags)).enabled).toBe(true);
    expect(warn).toHaveBeenCalledWith("Flag ignored, using its default:", {
      flag: SWEEP_ENABLED_FLAG,
    });
  });
});
