import { describe, expect, it } from "vite-plus/test";
import {
  type CapturePayload,
  declaredSensitiveCanonical,
  withoutSensitiveCanonicalUrl,
} from "../src/index.ts";

const payload: CapturePayload = {
  url: "https://example.com/article",
  canonical_url: "https://example.com/article?id=7",
  title: "Document title",
  og_site_name: "Example",
};

describe("withoutSensitiveCanonicalUrl", () => {
  it("returns the payload as it was when the canonical URL is fine, with no drop reported", () => {
    const screened = withoutSensitiveCanonicalUrl(payload);
    expect(screened).toEqual(payload);
    expect(declaredSensitiveCanonical(screened)).toBe(false);
  });

  it("returns the payload as it was when there is no canonical URL", () => {
    const { canonical_url: _none, ...withoutCanonical } = payload;
    const screened = withoutSensitiveCanonicalUrl(withoutCanonical);
    expect(screened).toEqual(withoutCanonical);
    expect(declaredSensitiveCanonical(screened)).toBe(false);
  });

  it.each([
    ["a credential parameter", "https://example.com/share?api_key=secret-value"],
    ["a fragment credential", "https://example.com/cb#access_token=secret-value"],
    ["a signed storage URL", "https://bucket.s3.amazonaws.com/file?X-Amz-Signature=secret-value"],
    ["embedded credentials", "https://user:secret-value@example.com/"],
    ["an http scheme, which a canonical URL may have", "http://example.com/?password=secret-value"],
  ])(
    "drops a canonical URL with %s, reports the drop and keeps every other field",
    (_, canonical_url) => {
      const screened = withoutSensitiveCanonicalUrl({ ...payload, canonical_url });
      expect(screened).toEqual({
        url: payload.url,
        title: payload.title,
        og_site_name: payload.og_site_name,
        sensitive_canonical_dropped: "1",
      });
      expect("canonical_url" in screened).toBe(false);
      expect(declaredSensitiveCanonical(screened)).toBe(true);
      // The URL itself is not kept anywhere in what it returns.
      expect(JSON.stringify(screened)).not.toContain("secret-value");
    },
  );

  it.each([
    ["a documentation anchor named like a credential", "https://example.com/docs#access_token"],
    ["a parameter with an empty value", "https://example.com/docs?api_key="],
    ["a parameter named token", "https://example.com/docs?token=abc"],
  ])("keeps a canonical URL with %s", (_, canonical_url) => {
    expect(withoutSensitiveCanonicalUrl({ ...payload, canonical_url }).canonical_url).toBe(
      canonical_url,
    );
  });

  it("drops a canonical URL that does not parse, instead of throwing, and reports no drop", () => {
    // It is not a flagged URL, because detectSensitiveUrl cannot read it.
    const screened = withoutSensitiveCanonicalUrl({ ...payload, canonical_url: "not a url" });
    expect("canonical_url" in screened).toBe(false);
    expect(screened.title).toBe(payload.title);
    expect(declaredSensitiveCanonical(screened)).toBe(false);
  });

  describe("when the payload already carries the flag", () => {
    const flagged = { ...payload, sensitive_canonical_dropped: "1" } as const;

    it("keeps it when the canonical URL is fine or absent", () => {
      const { canonical_url: _none, ...withoutCanonical } = flagged;
      expect(withoutSensitiveCanonicalUrl(flagged)).toEqual(flagged);
      expect(withoutSensitiveCanonicalUrl(withoutCanonical)).toEqual(withoutCanonical);
    });

    it("keeps it when the canonical URL does not parse", () => {
      const screened = withoutSensitiveCanonicalUrl({ ...flagged, canonical_url: "not a url" });
      expect(declaredSensitiveCanonical(screened)).toBe(true);
    });

    it("sets it once, not twice, when it also drops a flagged URL", () => {
      const screened = withoutSensitiveCanonicalUrl({
        ...flagged,
        canonical_url: "https://example.com/share?api_key=secret-value",
      });
      expect(screened).toEqual({
        url: payload.url,
        title: payload.title,
        og_site_name: payload.og_site_name,
        sensitive_canonical_dropped: "1",
      });
    });
  });

  it("does not change the page's own address, even when that is flagged", () => {
    // The page's address is checked before this runs, and its refusal is not this function's job.
    const flagged = { ...payload, url: "https://example.com/?api_key=secret-value" };
    expect(withoutSensitiveCanonicalUrl(flagged).url).toBe(flagged.url);
  });
});
