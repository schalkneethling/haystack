import { describe, expect, it } from "vite-plus/test";
import { CAPTURE_CAPS, truncate } from "../src/index.ts";

// U+1F600 is two UTF-16 code units: "😀".
const GRIN = "😀";

describe("truncate", () => {
  it.each([
    ["leaves a value under the cap", "abc", 5, "abc"],
    ["leaves a value exactly at the cap", "abcde", 5, "abcde"],
    ["cuts a value over the cap", "abcdef", 5, "abcde"],
    ["cuts to nothing at a cap of zero", "abc", 0, ""],
    ["leaves an empty value", "", 5, ""],
    ["keeps a pair that ends exactly at the cap", `abc${GRIN}d`, 5, `abc${GRIN}`],
    ["keeps a pair that is wholly before the cap", `${GRIN}abcd`, 4, `${GRIN}ab`],
    ["drops a pair that straddles the cap", `abcd${GRIN}`, 5, "abcd"],
    ["drops a pair that straddles a cap of one", `${GRIN}abc`, 1, ""],
    ["leaves a pair that fits whole at the cap", GRIN, 2, GRIN],
    ["drops only the pair it would split", `${GRIN}${GRIN}${GRIN}`, 5, `${GRIN}${GRIN}`],
    ["counts code units, not characters", "é".repeat(3), 2, "éé"],
  ])("%s", (_, value, maxLength, expected) => {
    expect(truncate(value, maxLength)).toBe(expected);
  });

  it("never returns a lone surrogate when the input had none", () => {
    const value = `a${GRIN}`.repeat(CAPTURE_CAPS.title);
    for (let cap = 0; cap <= 12; cap += 1) {
      const result = truncate(value, cap);
      // encodeURIComponent throws on a lone surrogate, which is why the schema rejects one.
      expect(() => encodeURIComponent(result)).not.toThrow();
      expect(result.length).toBeLessThanOrEqual(cap);
    }
  });
});
