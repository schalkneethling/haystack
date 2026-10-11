import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";
import { CAPTURE_CAPS, CapturePayload } from "../src/index.ts";

const full = {
  url: "https://example.com/article",
  canonical_url: "https://example.com/article",
  title: "An article",
  description: "What the article is about.",
  og_title: "An article (Open Graph)",
  og_description: "What the article is about, for sharing.",
  og_site_name: "Example",
};

type Field = keyof typeof CAPTURE_CAPS;
const fields = Object.keys(CAPTURE_CAPS) as Field[];

// A value of the given length that is valid for the field.
function valueOfLength(field: Field, length: number): string {
  if (field === "url" || field === "canonical_url") {
    const prefix = "https://example.com/";
    return prefix + "a".repeat(length - prefix.length);
  }
  return "a".repeat(length);
}

describe("CapturePayload", () => {
  it("accepts a full payload", () => {
    expect(v.parse(CapturePayload, full)).toEqual(full);
  });

  it("accepts a payload with only a URL", () => {
    expect(v.parse(CapturePayload, { url: "http://example.com/" })).toEqual({
      url: "http://example.com/",
    });
  });

  it("rejects a payload without a URL", () => {
    const { url: _, ...withoutUrl } = full;
    expect(v.safeParse(CapturePayload, withoutUrl).success).toBe(false);
  });

  it.each(fields)("accepts %s exactly at its cap", (field) => {
    const value = valueOfLength(field, CAPTURE_CAPS[field]);
    expect(v.parse(CapturePayload, { ...full, [field]: value })[field]).toBe(value);
  });

  it.each(fields)("rejects %s over its cap", (field) => {
    const value = valueOfLength(field, CAPTURE_CAPS[field] + 1);
    expect(v.safeParse(CapturePayload, { ...full, [field]: value }).success).toBe(false);
  });

  it.each(fields)("trims %s", (field) => {
    const value = full[field];
    expect(v.parse(CapturePayload, { ...full, [field]: `  ${value}\n` })[field]).toBe(value);
  });

  it("applies the cap after trimming", () => {
    const title = `  ${"a".repeat(CAPTURE_CAPS.title)}  `;
    expect(v.parse(CapturePayload, { ...full, title }).title).toHaveLength(CAPTURE_CAPS.title);
  });

  it.each(fields.filter((field) => field !== "url"))(
    "treats a whitespace-only %s as absent",
    (field) => {
      const result = v.parse(CapturePayload, { ...full, [field]: " \t " });
      expect(result).not.toHaveProperty(field);
    },
  );

  it.each(["url", "canonical_url"] as const)("rejects a value that is not a URL as %s", (field) => {
    expect(v.safeParse(CapturePayload, { ...full, [field]: "not a url" }).success).toBe(false);
  });

  describe.each(["url", "canonical_url"] as const)("%s scheme", (field) => {
    it.each([
      "javascript:alert(1)",
      "data:text/html,<p>hi</p>",
      "file:///etc/passwd",
      "ftp://example.com/file",
    ])("rejects %s", (value) => {
      expect(v.safeParse(CapturePayload, { ...full, [field]: value }).success).toBe(false);
    });

    it.each(["http://example.com/", "HTTPS://EXAMPLE.COM/"])("accepts %s", (value) => {
      expect(v.safeParse(CapturePayload, { ...full, [field]: value }).success).toBe(true);
    });
  });

  it.each(["", "   "])("rejects the URL %j", (url) => {
    expect(v.safeParse(CapturePayload, { url }).success).toBe(false);
  });

  it.each([
    ["an array", ["https://example.com/", "https://example.org/"]],
    ["null", null],
    ["a number", 42],
  ])("rejects %s as the URL", (_, url) => {
    expect(v.safeParse(CapturePayload, { url }).success).toBe(false);
  });

  describe.each(["url", "canonical_url"] as const)("%s as the parser reads it", (field) => {
    it.each([
      ["a leading control character", "\u0001https://example.com/"],
      ["a tab inside", "ht\ttps://example.com/"],
      ["a newline inside", "https://example.com/a\nb"],
      ["a DEL character", "https://example.com/\u007f"],
      ["no slashes after the scheme", "https:example.com"],
      ["one slash after the scheme", "http:/example.com"],
    ])("rejects %s", (_, value) => {
      expect(v.safeParse(CapturePayload, { ...full, [field]: value }).success).toBe(false);
    });
  });

  it("counts an emoji as two units toward the cap", () => {
    const atCap = "\u{1F600}".repeat(CAPTURE_CAPS.title / 2);
    expect(v.parse(CapturePayload, { ...full, title: atCap }).title).toBe(atCap);
    expect(v.safeParse(CapturePayload, { ...full, title: `${atCap}a` }).success).toBe(false);
  });

  it.each(["\ud83d", "\ude00", "a\ud83db"])(
    "rejects a lone surrogate in a text field (%j)",
    (value) => {
      expect(v.safeParse(CapturePayload, { ...full, title: value }).success).toBe(false);
    },
  );

  it("drops unknown keys", () => {
    expect(v.parse(CapturePayload, { url: full.url, extra: "x" })).toEqual({ url: full.url });
  });

  it("keeps the URL as submitted, apart from trimming", () => {
    const url = "HTTPS://Example.com:443/Path/?b=2&a=1#section";
    expect(v.parse(CapturePayload, { url: ` ${url} ` }).url).toBe(url);
  });
});
