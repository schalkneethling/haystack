import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";
import {
  CAPTURE_CAPS,
  CAPTURE_KEYS,
  CapturePayload,
  declaredSensitiveCanonical,
  SENSITIVE_CANONICAL_DROPPED,
  validateCapturePayload,
  withSensitiveCanonicalDropped,
} from "../src/index.ts";

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
    expect(v.parse(CapturePayload, { url: "https://example.com/" })).toEqual({
      url: "https://example.com/",
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

    it("accepts HTTPS://EXAMPLE.COM/", () => {
      expect(
        v.safeParse(CapturePayload, { ...full, [field]: "HTTPS://EXAMPLE.COM/" }).success,
      ).toBe(true);
    });
  });

  // Only https pages are saved (#40), so every saved address can be a link.
  it.each(["http://example.com/", "HTTP://EXAMPLE.COM/"])("rejects %s as the URL", (url) => {
    expect(validateCapturePayload({ ...full, url })).toEqual({ ok: false, invalidFields: ["url"] });
  });

  it.each(["http://example.com/article", "HTTP://EXAMPLE.COM/"])(
    "accepts %s as the canonical URL, which is never linked",
    (canonical_url) => {
      expect(v.parse(CapturePayload, { ...full, canonical_url }).canonical_url).toBe(canonical_url);
    },
  );

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
      ["a space in the query", "https://example.com/search?q=hello world"],
      ["a space before another parameter", "https://example.com/search?q=hello &b=1"],
      ["no slashes after the scheme", "https:example.com"],
      ["one slash after the scheme", "https:/example.com"],
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

  it.each(["url", "canonical_url"] as const)("rejects a lone surrogate in %s", (field) => {
    expect(
      v.safeParse(CapturePayload, { ...full, [field]: "https://example.com/a\ud800b" }).success,
    ).toBe(false);
  });

  it("drops unknown keys", () => {
    expect(v.parse(CapturePayload, { url: full.url, extra: "x" })).toEqual({ url: full.url });
  });

  it("keeps the URL as submitted, apart from trimming", () => {
    const url = "HTTPS://Example.com:443/Path/?b=2&a=1#section";
    expect(v.parse(CapturePayload, { url: ` ${url} ` }).url).toBe(url);
  });
});

describe("the flag that a canonical URL was dropped (#131)", () => {
  const url = "https://example.com/article";

  it("is named after the column that stores it", () => {
    expect(SENSITIVE_CANONICAL_DROPPED).toBe("sensitive_canonical_dropped");
  });

  it("is kept in the payload when it is 1, and read as set", () => {
    const payload = v.parse(CapturePayload, { url, [SENSITIVE_CANONICAL_DROPPED]: "1" });
    expect(payload).toEqual({ url, sensitive_canonical_dropped: "1" });
    expect(declaredSensitiveCanonical(payload)).toBe(true);
  });

  it("is written by withSensitiveCanonicalDropped, which the reader and the schema both accept", () => {
    const written = withSensitiveCanonicalDropped({ url });
    expect(written).toEqual({ url, sensitive_canonical_dropped: "1" });
    expect(declaredSensitiveCanonical(written)).toBe(true);
    expect(v.parse(CapturePayload, written)).toEqual(written);
  });

  it("is not set when the payload does not carry it", () => {
    expect(declaredSensitiveCanonical(v.parse(CapturePayload, { url }))).toBe(false);
  });

  // The flag is a hint, so a value other than "1" is not an error: the payload stays valid and
  // the flag is left out of it.
  it.each([
    ["0", "0"],
    ["true", "true"],
    ["an empty string", ""],
    ["1 with a space", " 1"],
    ["a number", 1],
    ["a boolean", true],
    ["null", null],
  ])("reads %s as not set, and the payload stays valid", (_, value) => {
    const validation = validateCapturePayload({ url, [SENSITIVE_CANONICAL_DROPPED]: value });
    expect(validation).toEqual({ ok: true, payload: { url } });
  });

  it("comes after the captured fields, the order in which the popup builds the save link", () => {
    const payload = v.parse(CapturePayload, { [SENSITIVE_CANONICAL_DROPPED]: "1", ...full });
    expect(Object.keys(payload).at(-1)).toBe(SENSITIVE_CANONICAL_DROPPED);
  });

  it("is a query key that /save reads, beside the captured fields", () => {
    expect(CAPTURE_KEYS).toEqual([...Object.keys(CAPTURE_CAPS), SENSITIVE_CANONICAL_DROPPED]);
  });
});

describe("validateCapturePayload", () => {
  it("returns the payload when valid", () => {
    expect(validateCapturePayload({ url: "https://example.com/" })).toEqual({
      ok: true,
      payload: { url: "https://example.com/" },
    });
  });

  it("names each invalid field without its value", () => {
    const result = validateCapturePayload({
      url: "javascript:alert(1)",
      title: "a".repeat(CAPTURE_CAPS.title + 1),
      description: "fine",
    });
    expect(result).toEqual({ ok: false, invalidFields: ["url", "title"] });
  });

  it("names a missing URL", () => {
    expect(validateCapturePayload({})).toEqual({ ok: false, invalidFields: ["url"] });
  });
});
