import { describe, expect, it } from "vite-plus/test";
import { CAPTURE_CAPS, capturedFieldsFromPage, PAGE_METADATA_KEYS } from "../src/index.ts";

const URL_ = "https://example.com/page";

describe("capturedFieldsFromPage", () => {
  it("names the values a page can give", () => {
    expect(PAGE_METADATA_KEYS).toEqual([
      "canonicalUrl",
      "documentTitle",
      "description",
      "ogTitle",
      "ogDescription",
      "ogSiteName",
    ]);
  });

  it("puts each value under the field /save reads", () => {
    expect(
      capturedFieldsFromPage(URL_, {
        canonicalUrl: "https://example.com/canonical",
        documentTitle: "Document title",
        description: "Meta description",
        ogTitle: "Sharing title",
        ogDescription: "Sharing description",
        ogSiteName: "Example",
      }),
    ).toEqual({
      url: URL_,
      canonical_url: "https://example.com/canonical",
      title: "Document title",
      description: "Meta description",
      og_title: "Sharing title",
      og_description: "Sharing description",
      og_site_name: "Example",
    });
  });

  it("leaves out the values a page does not give", () => {
    expect(capturedFieldsFromPage(URL_, { ogTitle: "Only this" })).toEqual({
      url: URL_,
      og_title: "Only this",
    });
  });

  it("trims text before cutting it to its cap, so whitespace does not use up the cap", () => {
    const fields = capturedFieldsFromPage(URL_, {
      documentTitle: `   ${"t".repeat(CAPTURE_CAPS.title + 5)}`,
      ogSiteName: "  Example  ",
    });
    expect(fields.title).toBe("t".repeat(CAPTURE_CAPS.title));
    expect(fields.og_site_name).toBe("Example");
  });

  it("serializes the canonical URL and never cuts it", () => {
    const long = `https://example.com/${"a".repeat(CAPTURE_CAPS.canonical_url)}`;
    expect(capturedFieldsFromPage(URL_, { canonicalUrl: " https://EXAMPLE.com/a b " })).toEqual({
      url: URL_,
      canonical_url: "https://example.com/a%20b",
    });
    expect(capturedFieldsFromPage(URL_, { canonicalUrl: long }).canonical_url).toBe(long);
  });
});
