// The configuration module (#128), with a fake Flagship binding. The harness's Flagship simulator
// holds no flags (Q13 in plans/haystack-v1-implementation-plan.md), so these are unit tests. The
// fake answers as the binding's details getters do: the flag's value when it has one, and
// otherwise the default it was given, with FLAG_NOT_FOUND, as for a missing flag.
// scheduled.test.ts shows what the scheduled run does with the values, and search-switch.test.ts
// what the Worker does with the search switch, through the fake Flagship Worker that
// createTestWorker starts (test-worker.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SWEEP_BATCH_SIZE_LIMIT } from "../src/enrichment/enrich-pending.ts";
import {
  type FlagDetails,
  type FlagReader,
  readSearchFlags,
  readSweepFlags,
  SEARCH_ENABLED_FLAG,
  SEARCH_FLAG_DEFAULTS,
  SWEEP_BATCH_SIZE_FLAG,
  SWEEP_ENABLED_FLAG,
  SWEEP_FLAG_DEFAULTS,
} from "../src/flags.ts";

/** A fake binding with these flags set, and every key it was asked for. */
function fakeFlags(values: Record<string, unknown>): FlagReader & { readonly keys: string[] } {
  const keys: string[] = [];
  const read = async <T>(key: string, defaultValue: T): Promise<FlagDetails<T>> => {
    keys.push(key);
    return Object.hasOwn(values, key)
      ? { value: values[key] as T }
      : { value: defaultValue, errorCode: "FLAG_NOT_FOUND" };
  };
  return { keys, getBooleanDetails: read, getNumberDetails: read };
}

/** A fake binding whose getters give their default with this error code, for every flag. */
function failingFlags(errorCode: string): FlagReader {
  const read = async <T>(_key: string, defaultValue: T): Promise<FlagDetails<T>> => ({
    value: defaultValue,
    errorCode,
  });
  return { getBooleanDetails: read, getNumberDetails: read };
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

  it("logs a missing switch by its key and the getter's code, but not a missing batch size", async () => {
    // A switch created in another app, or never created, gives the sweep enabled, so the log is
    // what shows that the switch isn't being read. The batch size flag is only created to lower
    // the batch, so its absence is the expected state.
    await readSweepFlags(fakeFlags({}));

    expect(warn).toHaveBeenCalledWith("Flag not evaluated, using its default:", {
      flag: SWEEP_ENABLED_FLAG,
      code: "FLAG_NOT_FOUND",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(["TYPE_MISMATCH", "PARSE_ERROR"])(
    "uses the defaults and logs %s for each flag",
    async (errorCode) => {
      expect(await readSweepFlags(failingFlags(errorCode))).toEqual(SWEEP_FLAG_DEFAULTS);
      for (const flag of [SWEEP_ENABLED_FLAG, SWEEP_BATCH_SIZE_FLAG]) {
        expect(warn).toHaveBeenCalledWith("Flag not evaluated, using its default:", {
          flag,
          code: errorCode,
        });
      }
    },
  );

  it.each(["flag sweep-enabled is true", "", "FLAG_NOT_FOUND\n"])(
    "logs an error code that isn't a plain code (%j) as UNRECOGNIZED",
    async (errorCode) => {
      await readSweepFlags(failingFlags(errorCode));

      expect(warn).toHaveBeenCalledWith("Flag not evaluated, using its default:", {
        flag: SWEEP_ENABLED_FLAG,
        code: "UNRECOGNIZED",
      });
    },
  );

  it("gives every default when the binding throws", async () => {
    // The switch's getter answers, but the batch size's throws, as the binding does for any
    // error other than a missing flag or a type mismatch (Q13).
    const flags: FlagReader = {
      getBooleanDetails: async () => ({ value: false }),
      getNumberDetails: async () => {
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

describe("readSearchFlags", () => {
  it.each([true, false])("reads the switch's value, %s", async (enabled) => {
    const flags = fakeFlags({ [SEARCH_ENABLED_FLAG]: enabled });

    expect(await readSearchFlags(flags)).toEqual({ enabled });
    expect(flags.keys).toEqual(["search-enabled"]);
    expect(warn).not.toHaveBeenCalled();
  });

  // Until #218 creates the flag, its absence is the expected state, and off is the safe one, so
  // it is not logged on every page load.
  it("gives search off for a missing flag, without logging it", async () => {
    expect(await readSearchFlags(fakeFlags({}))).toEqual({ enabled: false });
    expect(SEARCH_FLAG_DEFAULTS.enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["TYPE_MISMATCH", "PARSE_ERROR"])("gives search off and logs %s", async (errorCode) => {
    expect(await readSearchFlags(failingFlags(errorCode))).toEqual({ enabled: false });
    expect(warn).toHaveBeenCalledWith("Flag not evaluated, using its default:", {
      flag: SEARCH_ENABLED_FLAG,
      code: errorCode,
    });
  });

  it("gives search off when the binding throws, as during a Flagship outage", async () => {
    const flags: FlagReader = {
      getBooleanDetails: async () => {
        throw Object.assign(new Error("Flagship is unavailable"), { name: "FlagshipError" });
      },
      getNumberDetails: async () => ({ value: 0 }),
    };

    expect(await readSearchFlags(flags)).toEqual({ enabled: false });
    expect(error).toHaveBeenCalledWith("Flags unavailable, using the defaults:", {
      code: "FlagshipError",
    });
  });

  it("gives search off when the binding is missing, and logs it as an outage", async () => {
    const missing = undefined as unknown as FlagReader;

    expect(await readSearchFlags(missing)).toEqual({ enabled: false });
    // Calling a getter on no binding throws a TypeError, which is logged by its name.
    expect(error).toHaveBeenCalledWith("Flags unavailable, using the defaults:", {
      code: "TypeError",
    });
  });

  it.each(["true", 1, null])("replaces a switch that isn't a boolean (%s)", async (value) => {
    const flags = fakeFlags({ [SEARCH_ENABLED_FLAG]: value });

    expect(await readSearchFlags(flags)).toEqual({ enabled: false });
    expect(warn).toHaveBeenCalledWith("Flag ignored, using its default:", {
      flag: SEARCH_ENABLED_FLAG,
    });
  });
});
