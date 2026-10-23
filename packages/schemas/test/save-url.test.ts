// The popup's tests (apps/extension/test/open-save-form.test.ts) cover the budget at every step
// and every encoding. These cover the shared function on its own, for the Worker, which uses it
// for the address form's redirect.
import { describe, expect, it } from "vite-plus/test";
import { type CapturePayload, SAVE_URL_BUDGET, saveUrlWithinBudget } from "../src/index.ts";

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
