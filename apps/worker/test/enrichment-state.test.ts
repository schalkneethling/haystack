import { describe, expect, it } from "vite-plus/test";
import {
  deriveEnrichmentState,
  type EnrichmentStateInputs,
  type EnrichmentStatePolicy,
  readSensitiveWarnThreshold,
} from "../src/enrichment/state.ts";

const policy: EnrichmentStatePolicy = {
  schemaVersion: 2,
  sensitiveWarnThreshold: 0.7,
  attemptLimit: 3,
};

// A bookmark that was checked and found not sensitive, with no enrichment or failure.
function state(inputs: Partial<EnrichmentStateInputs>) {
  return deriveEnrichmentState(
    {
      sensitivityNoul: 0.1,
      sensitivityAcknowledgedAt: null,
      enrichmentVersions: [],
      failure: null,
      failureVersion: policy.schemaVersion,
      ...inputs,
    },
    policy,
  );
}

describe("deriveEnrichmentState", () => {
  it("refuses inputs read at another schema version", () => {
    // The failure record at version 1 says nothing about version 2, so with it the bookmark
    // could never be Failed.
    expect(() => state({ failure: { attempts: 3 }, failureVersion: 1 })).toThrow(
      "Enrichment state inputs were read at schema version 1, not 2",
    );
  });

  describe("held", () => {
    it("is a noul above the threshold without an acknowledgment", () => {
      expect(state({ sensitivityNoul: 0.9 })).toBe("held");
    });

    it("includes a noul exactly at the threshold, because the rule is at or above", () => {
      expect(state({ sensitivityNoul: 0.7 })).toBe("held");
    });

    it("is checked before current", () => {
      expect(state({ sensitivityNoul: 0.9, enrichmentVersions: [2] })).toBe("held");
    });

    it("is checked before failed", () => {
      expect(state({ sensitivityNoul: 0.9, failure: { attempts: 3 } })).toBe("held");
    });

    it("does not include a noul just below the threshold", () => {
      expect(state({ sensitivityNoul: 0.69 })).toBe("pending");
    });

    it("does not include an acknowledged bookmark above the threshold", () => {
      expect(state({ sensitivityNoul: 0.9, sensitivityAcknowledgedAt: 1_000 })).toBe("pending");
      expect(
        state({ sensitivityNoul: 0.9, sensitivityAcknowledgedAt: 1_000, enrichmentVersions: [2] }),
      ).toBe("current");
    });

    it("does not include a bookmark that was never checked", () => {
      expect(state({ sensitivityNoul: null })).toBe("pending");
      expect(state({ sensitivityNoul: null, enrichmentVersions: [2] })).toBe("current");
    });

    it("uses the threshold it is given, so lowering it holds a current bookmark", () => {
      const inputs: EnrichmentStateInputs = {
        sensitivityNoul: 0.6,
        sensitivityAcknowledgedAt: null,
        enrichmentVersions: [2],
        failure: null,
        failureVersion: 2,
      };
      expect(deriveEnrichmentState(inputs, policy)).toBe("current");
      expect(deriveEnrichmentState(inputs, { ...policy, sensitiveWarnThreshold: 0.5 })).toBe(
        "held",
      );
    });
  });

  describe("current", () => {
    it("is an enrichment at the current version", () => {
      expect(state({ enrichmentVersions: [2] })).toBe("current");
    });

    it("includes one that also has an enrichment at an older version", () => {
      expect(state({ enrichmentVersions: [1, 2] })).toBe("current");
    });

    it("is checked before failed", () => {
      expect(state({ enrichmentVersions: [2], failure: { attempts: 3 } })).toBe("current");
    });
  });

  describe("failed", () => {
    it("is a bookmark at the attempt limit with no enrichment", () => {
      expect(state({ failure: { attempts: 3 } })).toBe("failed");
    });

    it("includes one above the attempt limit", () => {
      expect(state({ failure: { attempts: 4 } })).toBe("failed");
    });

    it("is checked before outdated, for a bookmark with an older enrichment", () => {
      expect(state({ enrichmentVersions: [1], failure: { attempts: 3 } })).toBe("failed");
    });

    it("does not include a bookmark below the attempt limit", () => {
      expect(state({ failure: { attempts: 2 } })).toBe("pending");
      expect(state({ enrichmentVersions: [1], failure: { attempts: 2 } })).toBe("outdated");
    });

    it("does not include a record of transient failures only", () => {
      expect(state({ failure: { attempts: 0 } })).toBe("pending");
    });
  });

  describe("outdated", () => {
    it("is a bookmark with only an older enrichment", () => {
      expect(state({ enrichmentVersions: [1] })).toBe("outdated");
    });

    it("includes several older enrichments", () => {
      expect(state({ enrichmentVersions: [0, 1] })).toBe("outdated");
    });

    it("includes one with only a newer enrichment, as after a rollback", () => {
      expect(state({ enrichmentVersions: [3] })).toBe("outdated");
    });
  });

  describe("pending", () => {
    it("is a bookmark with no enrichment", () => {
      expect(state({})).toBe("pending");
    });
  });
});

describe("readSensitiveWarnThreshold", () => {
  it.each([
    ["0.5", 0.5],
    ["0", 0],
    ["1", 1],
    ["0.05", 0.05],
    ["1.0", 1],
  ])("reads %s as %d", (value, threshold) => {
    expect(readSensitiveWarnThreshold({ SENSITIVE_WARN_THRESHOLD: value })).toBe(threshold);
  });

  // Number() reads each of the first four as a number, so a mistyped value would otherwise hold
  // every bookmark or none.
  it.each([
    ["an empty string", ""],
    ["whitespace", " "],
    ["a hexadecimal number", "0x1"],
    ["an exponent", "5e-1"],
    ["a number above 1", "1.5"],
    ["a negative number", "-0.5"],
    ["a percentage", "50%"],
    ["a value with spaces around it", " 0.5 "],
    ["a missing value", undefined as unknown as string],
  ])("refuses %s, with a code that names the variable", (_, value) => {
    expect(() => readSensitiveWarnThreshold({ SENSITIVE_WARN_THRESHOLD: value })).toThrow(
      expect.objectContaining({ code: "SENSITIVE_WARN_THRESHOLD_INVALID" }),
    );
  });
});
