import { describe, expect, it } from "vite-plus/test";
import { normalizeUrl, stripTrackingParameters } from "../src/index.ts";

describe("stripTrackingParameters", () => {
  it.each([
    [
      "removes utm parameters",
      "https://example.com/a?utm_source=x&utm_medium=y",
      "https://example.com/a",
    ],
    [
      "removes click IDs",
      "https://example.com/a?fbclid=1&id=7&gclid=2",
      "https://example.com/a?id=7",
    ],
    [
      "removes tracking keys in any case",
      "https://example.com/a?UTM_Source=x&b=1",
      "https://example.com/a?b=1",
    ],
    [
      "removes a percent-encoded tracking key",
      "https://example.com/a?utm%5Fsource=x&b=1",
      "https://example.com/a?b=1",
    ],
    [
      "removes a tracking key without a value",
      "https://example.com/a?utm_source&b=1",
      "https://example.com/a?b=1",
    ],
    [
      "keeps the order of other parameters",
      "https://example.com/a?z=1&utm_id=x&a=2",
      "https://example.com/a?z=1&a=2",
    ],
    [
      "keeps the fragment",
      "https://example.com/a?utm_source=x#section",
      "https://example.com/a#section",
    ],
    [
      "keeps the fragment after kept parameters",
      "https://example.com/a?b=1&utm_source=x#s",
      "https://example.com/a?b=1#s",
    ],
    [
      "keeps the trailing slash",
      "https://example.com/docs/?utm_source=x",
      "https://example.com/docs/",
    ],
    [
      "keeps case and encoding",
      "HTTPS://Example.com/A%20B?Q=a+b&utm_source=x",
      "HTTPS://Example.com/A%20B?Q=a+b",
    ],
    [
      "keeps legitimate lookalikes",
      "https://example.com/a?utm=1&ref=2",
      "https://example.com/a?utm=1&ref=2",
    ],
    [
      "leaves a URL without a query alone",
      "https://example.com/a#utm_source=x",
      "https://example.com/a#utm_source=x",
    ],
    [
      "leaves tracking-like text in the fragment alone",
      "https://example.com/a?b=1#?utm_source=x",
      "https://example.com/a?b=1#?utm_source=x",
    ],
    [
      "leaves a query with nothing to remove unchanged",
      "https://example.com/a?&&b=1&",
      "https://example.com/a?&&b=1&",
    ],
  ])("%s", (_, input, expected) => {
    expect(stripTrackingParameters(input)).toBe(expected);
  });

  it("gives the same normalized value as the unstripped URL", () => {
    const url = "https://Example.com/a/?b=2&utm_source=x&a=1&fbclid=y#top";
    expect(normalizeUrl(stripTrackingParameters(url))).toBe(normalizeUrl(url));
  });
});
