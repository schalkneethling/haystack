import { describe, expect, it } from "vite-plus/test";
import { normalizeUrl, TRACKING_PARAMETERS } from "../src/index.ts";

// Written out, not read from TRACKING_PARAMETERS: changing the list changes stored
// normalized_url values and needs a migration, so it must also change this test.
const TRACKING_LIST = [
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
];

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
    ...TRACKING_LIST,
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

  it("exports exactly the tracking parameters listed in this test", () => {
    expect(TRACKING_PARAMETERS).toEqual(TRACKING_LIST);
  });

  it("does not let importers change the tracking list", () => {
    expect(Object.isFrozen(TRACKING_PARAMETERS)).toBe(true);
  });

  it.each([
    ["a value containing =", "https://example.com/a?b=c=d", "https://example.com/a?b=c=d"],
    [
      "malformed percent-encoding in a key",
      "https://example.com/a?%zz=1&a=2",
      "https://example.com/a?%zz=1&a=2",
    ],
    [
      "a tracking key without a value",
      "https://example.com/a?utm_source&b=1",
      "https://example.com/a?b=1",
    ],
    ["a query after a trailing slash", "https://example.com/a/?b=1", "https://example.com/a?b=1"],
    ["an empty path with a query", "https://example.com?b=1", "https://example.com?b=1"],
  ])("handles %s", (_, input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it("sorts by decoded key, keeping the order of keys that decode to the same name", () => {
    expect(normalizeUrl("https://example.com/?a+b=2&a%20b=1&a=0")).toBe(
      "https://example.com?a=0&a+b=2&a%20b=1",
    );
    expect(normalizeUrl("https://example.com/?a%20b=1&a+b=2")).not.toBe(
      normalizeUrl("https://example.com/?a+b=2&a%20b=1"),
    );
  });

  it.each([
    "mailto:a@example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://example.com/a",
    "blob:https://example.com/id",
  ])("throws for the non-http URL %s", (input) => {
    expect(() => normalizeUrl(input)).toThrow(TypeError);
  });

  it("throws for a value that is not a URL", () => {
    expect(() => normalizeUrl("not a url")).toThrow(TypeError);
  });
});
