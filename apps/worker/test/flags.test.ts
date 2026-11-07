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
  readSearchSettings,
  readSweepFlags,
  SEARCH_DISPLAY_SIGNAL_FLAG,
  SEARCH_ENABLED_FLAG,
  SEARCH_FLAG_DEFAULTS,
  SEARCH_NOUL_THRESHOLD_FLAG,
  SEARCH_QUESTIONS_FLAG,
  SEARCH_REQUEST_MODE_FLAG,
  SEARCH_SCORE_THRESHOLD_FLAG,
  SEARCH_SETTING_DEFAULTS,
  SWEEP_BATCH_SIZE_FLAG,
  SWEEP_ENABLED_FLAG,
  SWEEP_FLAG_DEFAULTS,
} from "../src/flags.ts";
import { RELEVANCE_SCORE_MAX } from "../src/search/jev-search.ts";

/** A fake binding with these flags set, and every key it was asked for. */
function fakeFlags(values: Record<string, unknown>): FlagReader & { readonly keys: string[] } {
  const keys: string[] = [];
  const read = async <T>(key: string, defaultValue: T): Promise<FlagDetails<T>> => {
    keys.push(key);
    return Object.hasOwn(values, key)
      ? { value: values[key] as T }
      : { value: defaultValue, errorCode: "FLAG_NOT_FOUND" };
  };
  return { keys, getBooleanDetails: read, getNumberDetails: read, getStringDetails: read };
}

/** A fake binding whose getters give their default with this error code, for every flag. */
function failingFlags(errorCode: string): FlagReader {
  const read = async <T>(_key: string, defaultValue: T): Promise<FlagDetails<T>> => ({
    value: defaultValue,
    errorCode,
  });
  return { getBooleanDetails: read, getNumberDetails: read, getStringDetails: read };
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
      getStringDetails: async () => ({ value: "" }),
    };

    expect(await readSweepFlags(flags)).toEqual({ enabled: true, batchSize: 3 });
    expect(error).toHaveBeenCalledWith("Flags unavailable, using the defaults:", {
      flag: SWEEP_BATCH_SIZE_FLAG,
      code: "FlagshipError",
    });
  });

  it("gives every default when the binding is missing", async () => {
    // `Env` says the binding is there, but a configuration without it would bind nothing.
    const missing = undefined as unknown as FlagReader;

    expect(await readSweepFlags(missing)).toEqual({ enabled: true, batchSize: 3 });
    // Both reads throw, and the line names the first.
    expect(error).toHaveBeenCalledExactlyOnceWith("Flags unavailable, using the defaults:", {
      flag: SWEEP_ENABLED_FLAG,
      code: "TypeError",
    });
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
      getStringDetails: async () => ({ value: "" }),
    };

    expect(await readSearchFlags(flags)).toEqual({ enabled: false });
    expect(error).toHaveBeenCalledWith("Flags unavailable, using the defaults:", {
      flag: SEARCH_ENABLED_FLAG,
      code: "FlagshipError",
    });
  });

  it("gives search off when the binding is missing, and logs it as an outage", async () => {
    const missing = undefined as unknown as FlagReader;

    expect(await readSearchFlags(missing)).toEqual({ enabled: false });
    // Calling a getter on no binding throws a TypeError, which is logged by its name.
    expect(error).toHaveBeenCalledWith("Flags unavailable, using the defaults:", {
      flag: SEARCH_ENABLED_FLAG,
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

describe("readSearchSettings", () => {
  // Every setting at a value other than its default, so each one shows that the live value is
  // handed on.
  const live = {
    [SEARCH_QUESTIONS_FLAG]: "noul",
    [SEARCH_DISPLAY_SIGNAL_FLAG]: "noul",
    [SEARCH_NOUL_THRESHOLD_FLAG]: 0.7,
    [SEARCH_SCORE_THRESHOLD_FLAG]: 2.25,
    [SEARCH_REQUEST_MODE_FLAG]: "pair",
  };
  const liveSettings = {
    questions: "noul",
    displaySignal: "noul",
    noulThreshold: 0.7,
    scoreThreshold: 2.25,
    requestMode: "pair",
  };

  it("reads each setting's value", async () => {
    expect(await readSearchSettings(fakeFlags(live))).toEqual(liveSettings);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads each flag once, by its constant key", async () => {
    const flags = fakeFlags({});

    await readSearchSettings(flags);

    expect(flags.keys.toSorted()).toEqual([
      "search-display-signal",
      "search-noul-threshold",
      "search-questions",
      "search-request-mode",
      "search-score-threshold",
    ]);
  });

  it.each([
    [{ [SEARCH_QUESTIONS_FLAG]: "both" }, { questions: "both" }],
    [{ [SEARCH_QUESTIONS_FLAG]: "score" }, { questions: "score" }],
    [
      { [SEARCH_QUESTIONS_FLAG]: "noul", [SEARCH_DISPLAY_SIGNAL_FLAG]: "noul" },
      { questions: "noul", displaySignal: "noul" },
    ],
    [{ [SEARCH_DISPLAY_SIGNAL_FLAG]: "noul" }, { displaySignal: "noul" }],
    [{ [SEARCH_DISPLAY_SIGNAL_FLAG]: "score" }, { displaySignal: "score" }],
    [{ [SEARCH_REQUEST_MODE_FLAG]: "pair" }, { requestMode: "pair" }],
    [{ [SEARCH_REQUEST_MODE_FLAG]: "batched" }, { requestMode: "batched" }],
    [{ [SEARCH_NOUL_THRESHOLD_FLAG]: 0 }, { noulThreshold: 0 }],
    [{ [SEARCH_NOUL_THRESHOLD_FLAG]: 1 }, { noulThreshold: 1 }],
    [{ [SEARCH_SCORE_THRESHOLD_FLAG]: 0 }, { scoreThreshold: 0 }],
    [{ [SEARCH_SCORE_THRESHOLD_FLAG]: RELEVANCE_SCORE_MAX }, { scoreThreshold: 3 }],
  ])("keeps the allowed value %j", async (values, expected) => {
    expect(await readSearchSettings(fakeFlags(values))).toEqual({
      ...SEARCH_SETTING_DEFAULTS,
      ...expected,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  // Until Phase 12 (#225) creates a flag, its absence is the expected state, so it is not logged
  // on every search.
  it("gives the plan's defaults for missing flags, without logging them", async () => {
    expect(await readSearchSettings(fakeFlags({}))).toEqual({
      questions: "both",
      displaySignal: "score",
      noulThreshold: 0.5,
      scoreThreshold: 1.5,
      requestMode: "batched",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["TYPE_MISMATCH", "PARSE_ERROR"])(
    "uses the defaults and logs %s for each flag",
    async (errorCode) => {
      expect(await readSearchSettings(failingFlags(errorCode))).toEqual(SEARCH_SETTING_DEFAULTS);
      for (const flag of Object.keys(live)) {
        expect(warn).toHaveBeenCalledWith("Flag not evaluated, using its default:", {
          flag,
          code: errorCode,
        });
      }
      expect(warn).toHaveBeenCalledTimes(5);
    },
  );

  it.each(["flag search-request-mode is pair", "", "TYPE_MISMATCH\n"])(
    "logs an error code that isn't a plain code (%j) as UNRECOGNIZED",
    async (errorCode) => {
      await readSearchSettings(failingFlags(errorCode));

      expect(warn).toHaveBeenCalledWith("Flag not evaluated, using its default:", {
        flag: SEARCH_REQUEST_MODE_FLAG,
        code: "UNRECOGNIZED",
      });
    },
  );

  it("never logs the getter's errorMessage", async () => {
    // The simulator's message for a type mismatch describes the flag's value (TypeCastError).
    const errorMessage = "Flag 'search-request-mode' has type 'number', expected 'string'";
    const read = async <T>(_key: string, defaultValue: T): Promise<FlagDetails<T>> => {
      const details = { value: defaultValue, errorCode: "TYPE_MISMATCH", errorMessage };
      return details;
    };
    const flags: FlagReader = {
      getBooleanDetails: read,
      getNumberDetails: read,
      getStringDetails: read,
    };

    await readSearchSettings(flags);

    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain("has type");
  });

  it("gives every default when the binding throws, even when the other reads worked", async () => {
    // The string getter answers with live values, but the number getter throws, as the binding
    // does for any error other than a missing flag or a type mismatch (Q13).
    const flags: FlagReader = {
      getBooleanDetails: async () => ({ value: true }),
      getNumberDetails: async () => {
        throw Object.assign(new Error("Flagship is unavailable for search-noul-threshold"), {
          name: "FlagshipError",
        });
      },
      getStringDetails: async () => ({ value: "noul" }),
    };

    expect(await readSearchSettings(flags)).toEqual(SEARCH_SETTING_DEFAULTS);
    // Both thresholds' reads throw, and the line names the first.
    expect(error).toHaveBeenCalledExactlyOnceWith("Flags unavailable, using the defaults:", {
      flag: SEARCH_NOUL_THRESHOLD_FLAG,
      code: "FlagshipError",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("unavailable for");
  });

  // Promise.all rejects with the read that fails first in time, so a fast failure of a later
  // flag is named over a slow failure of an earlier one, as in an outage where one read times out.
  it("names the flag whose read failed first in time", async () => {
    const failing = (code: string, ms: number) =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error("Flagship failed"), { code })), ms);
      });
    const flags: FlagReader = {
      getBooleanDetails: () => failing("ETIMEDOUT", 50),
      getNumberDetails: () => failing("ETIMEDOUT", 50),
      getStringDetails: (key) =>
        failing(
          key === SEARCH_REQUEST_MODE_FLAG ? "ECONNRESET" : "ETIMEDOUT",
          key === SEARCH_REQUEST_MODE_FLAG ? 0 : 50,
        ),
    };

    expect(await readSearchSettings(flags)).toEqual(SEARCH_SETTING_DEFAULTS);
    expect(error).toHaveBeenCalledExactlyOnceWith("Flags unavailable, using the defaults:", {
      flag: SEARCH_REQUEST_MODE_FLAG,
      code: "ECONNRESET",
    });
  });

  it("names the flag whose read threw, not the first flag", async () => {
    const live = fakeFlags({});
    const flags: FlagReader = {
      ...live,
      getNumberDetails: async (key, defaultValue) => {
        if (key === SEARCH_SCORE_THRESHOLD_FLAG) {
          throw Object.assign(new Error("Flagship failed"), { code: "ECONNRESET" });
        }
        return live.getNumberDetails(key, defaultValue);
      },
    };

    expect(await readSearchSettings(flags)).toEqual(SEARCH_SETTING_DEFAULTS);
    expect(error).toHaveBeenCalledExactlyOnceWith("Flags unavailable, using the defaults:", {
      flag: SEARCH_SCORE_THRESHOLD_FLAG,
      code: "ECONNRESET",
    });
  });

  it("gives every default when the binding is missing, and logs it as an outage", async () => {
    const missing = undefined as unknown as FlagReader;

    expect(await readSearchSettings(missing)).toEqual(SEARCH_SETTING_DEFAULTS);
    // All five reads throw, and the line names the first.
    expect(error).toHaveBeenCalledExactlyOnceWith("Flags unavailable, using the defaults:", {
      flag: SEARCH_QUESTIONS_FLAG,
      code: "TypeError",
    });
  });

  it.each([
    [SEARCH_QUESTIONS_FLAG, "questions", "Both"],
    [SEARCH_QUESTIONS_FLAG, "questions", "noul,score"],
    [SEARCH_DISPLAY_SIGNAL_FLAG, "displaySignal", "relevance"],
    [SEARCH_REQUEST_MODE_FLAG, "requestMode", "batched "],
    [SEARCH_REQUEST_MODE_FLAG, "requestMode", ""],
  ] as const)(
    "replaces a %s that isn't allowed (%j) with its default, and keeps the others",
    async (flag, setting, value) => {
      const flags = fakeFlags({ ...live, [flag]: value });

      expect(await readSearchSettings(flags)).toEqual({
        ...liveSettings,
        [setting]: SEARCH_SETTING_DEFAULTS[setting],
      });
      expect(warn).toHaveBeenCalledWith("Flag ignored, using its default:", { flag });
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [SEARCH_NOUL_THRESHOLD_FLAG, "noulThreshold", -0.01],
    [SEARCH_NOUL_THRESHOLD_FLAG, "noulThreshold", 1.01],
    [SEARCH_NOUL_THRESHOLD_FLAG, "noulThreshold", 75],
    [SEARCH_NOUL_THRESHOLD_FLAG, "noulThreshold", Number.NaN],
    [SEARCH_NOUL_THRESHOLD_FLAG, "noulThreshold", Number.POSITIVE_INFINITY],
    [SEARCH_SCORE_THRESHOLD_FLAG, "scoreThreshold", -1],
    [SEARCH_SCORE_THRESHOLD_FLAG, "scoreThreshold", 3.01],
    [SEARCH_SCORE_THRESHOLD_FLAG, "scoreThreshold", Number.NaN],
    [SEARCH_SCORE_THRESHOLD_FLAG, "scoreThreshold", Number.NEGATIVE_INFINITY],
  ] as const)(
    "replaces a %s outside its range (%s) with its default, and keeps the others",
    async (flag, setting, value) => {
      const flags = fakeFlags({ ...live, [flag]: value });

      expect(await readSearchSettings(flags)).toEqual({
        ...liveSettings,
        [setting]: SEARCH_SETTING_DEFAULTS[setting],
      });
      expect(warn).toHaveBeenCalledWith("Flag ignored, using its default:", { flag });
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [SEARCH_QUESTIONS_FLAG, "questions", 1],
    [SEARCH_DISPLAY_SIGNAL_FLAG, "displaySignal", null],
    [SEARCH_REQUEST_MODE_FLAG, "requestMode", true],
    [SEARCH_NOUL_THRESHOLD_FLAG, "noulThreshold", "0.7"],
    [SEARCH_SCORE_THRESHOLD_FLAG, "scoreThreshold", null],
    [SEARCH_SCORE_THRESHOLD_FLAG, "scoreThreshold", false],
  ] as const)(
    "replaces a %s of the wrong type (%j) with its default, and keeps the others",
    async (flag, setting, value) => {
      const flags = fakeFlags({ ...live, [flag]: value });

      expect(await readSearchSettings(flags)).toEqual({
        ...liveSettings,
        [setting]: SEARCH_SETTING_DEFAULTS[setting],
      });
      expect(warn).toHaveBeenCalledWith("Flag ignored, using its default:", { flag });
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  // Each flag is checked on its own. What a search does when the questions leave out the display
  // signal is the search service's decision (#212), so the module hands on both as they are.
  it("keeps live questions of noul when the display signal falls back to the Score", async () => {
    const flags = fakeFlags({
      [SEARCH_QUESTIONS_FLAG]: "noul",
      [SEARCH_DISPLAY_SIGNAL_FLAG]: "relevance",
    });

    expect(await readSearchSettings(flags)).toMatchObject({
      questions: "noul",
      displaySignal: "score",
    });
    expect(warn).toHaveBeenCalledWith("Flag ignored, using its default:", {
      flag: SEARCH_DISPLAY_SIGNAL_FLAG,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["noul", "score"],
    ["score", "noul"],
  ])("hands on questions of %s with the %s signal unchanged", async (questions, signal) => {
    const flags = fakeFlags({
      [SEARCH_QUESTIONS_FLAG]: questions,
      [SEARCH_DISPLAY_SIGNAL_FLAG]: signal,
    });

    expect(await readSearchSettings(flags)).toMatchObject({ questions, displaySignal: signal });
    expect(warn).not.toHaveBeenCalled();
  });
});

// The error a getter throws comes from an outside service too, so its code or name is logged
// only when it is a plain code, an error's name, or errorCode's own string for a value that
// isn't an Error.
describe("the log line for a thrown error", () => {
  function throwing(thrown: unknown): FlagReader {
    const read = async (): Promise<never> => {
      throw thrown;
    };
    return { getBooleanDetails: read, getNumberDetails: read, getStringDetails: read };
  }

  const coded = (code: string) => Object.assign(new Error("Flagship failed"), { code });
  const named = (name: string) => Object.assign(new Error("Flagship failed"), { name });

  it.each([
    ["a plain code", coded("ECONNRESET"), "ECONNRESET"],
    ["an error's name", named("FlagshipError"), "FlagshipError"],
    ["TypeError", new TypeError("flags is undefined"), "TypeError"],
    ["a plain Error", new Error("Flagship failed"), "Error"],
    ["a value that isn't an Error", "Flagship failed", "unknown error"],
    ["a code that holds a value", coded("search-request-mode=pair"), "UNRECOGNIZED"],
    ["a lower-case code", coded("batched"), "UNRECOGNIZED"],
    ["a code with a newline", coded("FLAG_NOT_FOUND\n"), "UNRECOGNIZED"],
    ["an empty code", coded(""), "UNRECOGNIZED"],
    ["a name that isn't an error's", named("Pair"), "UNRECOGNIZED"],
    ["a name with a space", named("Flag search-questions Error"), "UNRECOGNIZED"],
  ])("logs %s by what is allowed of it", async (_case, thrown, code) => {
    // Every read throws, so each reader's line names its first flag.
    for (const [read, flag] of [
      [readSweepFlags, SWEEP_ENABLED_FLAG],
      [readSearchFlags, SEARCH_ENABLED_FLAG],
      [readSearchSettings, SEARCH_QUESTIONS_FLAG],
    ] as const) {
      error.mockClear();

      await read(throwing(thrown));

      expect(error).toHaveBeenCalledExactlyOnceWith("Flags unavailable, using the defaults:", {
        flag,
        code,
      });
    }
  });
});
