import { describe, expect, it } from "vite-plus/test";
import { normalizeUrl, TRACKING_PARAMETERS } from "../src/index.ts";

describe("normalizeUrl", () => {
  it.each([
    ["lowercases the scheme and host", "HTTPS://Example.COM/Path", "https://example.com/Path"],
    ["removes the default https port", "https://example.com:443/a", "https://example.com/a"],
    ["removes the default http port", "http://example.com:80/a", "http://example.com/a"],
    ["keeps a non-default port", "https://example.com:8443/a", "https://example.com:8443/a"],
    ["removes the fragment", "https://example.com/a#section", "https://example.com/a"],
    ["removes credentials", "https://user:pass@example.com/a", "https://example.com/a"],
    ["removes the root trailing slash", "https://example.com/", "https://example.com"],
    ["removes a deeper trailing slash", "https://example.com/docs/", "https://example.com/docs"],
    ["removes only one trailing slash", "https://example.com/docs//", "https://example.com/docs/"],
    ["sorts parameters by key", "https://example.com/?b=2&a=1", "https://example.com?a=1&b=2"],
    [
      "keeps repeated keys in order",
      "https://example.com/?t=2&a=1&t=1",
      "https://example.com?a=1&t=2&t=1",
    ],
    ["drops an empty query", "https://example.com/a?", "https://example.com/a"],
    ["drops empty pairs", "https://example.com/a?&b=1&&", "https://example.com/a?b=1"],
    ["keeps a key without a value", "https://example.com/a?flag", "https://example.com/a?flag"],
    [
      "keeps percent-encoding as written",
      "https://example.com/?q=a%20b&r=a+b",
      "https://example.com?q=a%20b&r=a+b",
    ],
    ["keeps path case", "https://example.com/Docs/API", "https://example.com/Docs/API"],
    ["keeps www", "https://www.example.com/", "https://www.example.com"],
    ["keeps the scheme", "http://example.com/", "http://example.com"],
    [
      "converts an IDN host to punycode",
      "https://bücher.example/",
      "https://xn--bcher-kva.example",
    ],
  ])("%s", (_, input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it("gives the same value for URLs that differ only in parameter order", () => {
    expect(normalizeUrl("https://example.com/s?q=x&page=2")).toBe(
      normalizeUrl("https://example.com/s?page=2&q=x"),
    );
  });

  it.each([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    ...TRACKING_PARAMETERS,
  ])("removes the tracking parameter %s", (key) => {
    expect(normalizeUrl(`https://example.com/a?${key}=x&keep=1`)).toBe(
      "https://example.com/a?keep=1",
    );
  });

  it.each(["UTM_Source", "FBCLID", "GClid"])(
    "removes the tracking parameter %s in any case",
    (key) => {
      expect(normalizeUrl(`https://example.com/a?${key}=x`)).toBe("https://example.com/a");
    },
  );

  it("removes a percent-encoded tracking key", () => {
    expect(normalizeUrl("https://example.com/a?utm%5Fsource=x")).toBe("https://example.com/a");
  });

  it.each(["utm", "utmsource", "ref", "source", "gclid_page"])(
    "keeps the legitimate parameter %s",
    (key) => {
      expect(normalizeUrl(`https://example.com/a?${key}=x`)).toBe(`https://example.com/a?${key}=x`);
    },
  );

  it("removes tracking parameters from the fragment along with the fragment", () => {
    expect(normalizeUrl("https://example.com/a?b=1#utm_source=x")).toBe(
      "https://example.com/a?b=1",
    );
  });

  it("throws for a value that is not a URL", () => {
    expect(() => normalizeUrl("not a url")).toThrow(TypeError);
  });
});
