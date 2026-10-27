// The popup's tests (apps/extension/test/open-save-form.test.ts) cover the budget at every step
// and every encoding. These cover the shared function on its own, for the Worker, which uses it
// for the address form's redirect.
import { describe, expect, it } from "vite-plus/test";
import {
  CAPTURE_CAPS,
  type CapturePayload,
  SAVE_URL_BUDGET,
  saveUrlWithinBudget,
} from "../src/index.ts";

const ORIGIN = "https://haystack.example";

// Written out here on purpose, so that a change to the order fails a test.
const DROP_ORDER = [
  "og_description",
  "description",
  "og_title",
  "og_site_name",
  "canonical_url",
] as const;

const FULL: CapturePayload = {
  url: "https://example.com/page",
  canonical_url: "https://example.com/canonical",
  title: "A title",
  description: "A description",
  og_title: "A sharing title",
  og_description: "A sharing description",
  og_site_name: "Example",
};

function fieldsOf(saveUrl: string): string[] {
  return [...new URL(saveUrl).searchParams.keys()];
}

describe("saveUrlWithinBudget", () => {
  it("builds the Worker's /save link with every field, under the names /save reads", () => {
    const target = saveUrlWithinBudget(ORIGIN, FULL);
    expect(target.startsWith(`${ORIGIN}/save?`)).toBe(true);
    expect(Object.fromEntries(new URL(target).searchParams)).toEqual(FULL);
  });

  it("is 8,000 characters", () => {
    expect(SAVE_URL_BUDGET).toBe(8000);
  });

  // The first `dropped` fields of the order are each over the budget on their own, so each of
  // them has to go, and the rest are short, so the link fits as soon as they are gone.
  it.each([0, 1, 2, 3, 4, 5])(
    "drops the first %i fields of the order, and stops once the link fits",
    (dropped) => {
      const gone = DROP_ORDER.slice(0, dropped);
      const payload: CapturePayload = { ...FULL };
      for (const field of gone) {
        payload[field] =
          `${field === "canonical_url" ? "https://example.com/" : ""}${"a".repeat(SAVE_URL_BUDGET)}`;
      }
      const target = saveUrlWithinBudget(ORIGIN, payload);
      expect(target.length).toBeLessThanOrEqual(SAVE_URL_BUDGET);
      expect(fieldsOf(target).sort()).toEqual(
        Object.keys(FULL)
          .filter((field) => !(gone as readonly string[]).includes(field))
          .sort(),
      );
    },
  );

  // The flag that a canonical URL was dropped (#131) is the only trace of that URL, so the budget
  // never drops it: it is not in the order, and it stays when every field that can go has gone.
  describe("the flag that a canonical URL was dropped", () => {
    const FLAG = { sensitive_canonical_dropped: "1" } as const;

    it("is in the link, after the fields, under its own name", () => {
      const target = saveUrlWithinBudget(ORIGIN, { ...FULL, ...FLAG });
      expect(fieldsOf(target).at(-1)).toBe("sensitive_canonical_dropped");
      expect(Object.fromEntries(new URL(target).searchParams)).toEqual({ ...FULL, ...FLAG });
    });

    it("is kept while every droppable field goes", () => {
      const payload: CapturePayload = { ...FULL, ...FLAG };
      for (const field of DROP_ORDER) {
        payload[field] =
          `${field === "canonical_url" ? "https://example.com/" : ""}${"a".repeat(SAVE_URL_BUDGET)}`;
      }
      const target = saveUrlWithinBudget(ORIGIN, payload);
      expect(fieldsOf(target).sort()).toEqual(["sensitive_canonical_dropped", "title", "url"]);
      expect(target.length).toBeLessThanOrEqual(SAVE_URL_BUDGET);
    });

    it("is kept at the budget with every field at its cap", () => {
      // The longest values that encode to the most characters: 9 for each of 標 and 3 for each
      // reserved character of the address, so the link is far over the budget.
      const payload: CapturePayload = {
        url: `https://example.com/${"/".repeat(CAPTURE_CAPS.url - "https://example.com/".length)}`,
        canonical_url: `https://example.com/${"/".repeat(CAPTURE_CAPS.canonical_url - "https://example.com/".length)}`,
        title: "標".repeat(CAPTURE_CAPS.title),
        description: "標".repeat(CAPTURE_CAPS.description),
        og_title: "標".repeat(CAPTURE_CAPS.og_title),
        og_description: "標".repeat(CAPTURE_CAPS.og_description),
        og_site_name: "標".repeat(CAPTURE_CAPS.og_site_name),
        ...FLAG,
      };
      const target = saveUrlWithinBudget(ORIGIN, payload);
      expect(fieldsOf(target)).toContain("sensitive_canonical_dropped");
      expect(new URL(target).searchParams.get("sensitive_canonical_dropped")).toBe("1");
    });
  });

  it("never drops the address or the title", () => {
    const payload: CapturePayload = {
      url: `https://example.com/${"/".repeat(2028)}`,
      title: "標".repeat(200),
      og_site_name: "標".repeat(100),
    };
    const target = saveUrlWithinBudget(ORIGIN, payload);
    expect(fieldsOf(target)).toEqual(["url", "title"]);
  });
});
