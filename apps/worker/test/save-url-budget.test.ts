// The extension keeps its save URL within SAVE_URL_BUDGET so that the sign-in redirect for a
// signed-out /save request stays under Cloudflare's URL limit. See "Captured payload from the
// extension" in plans/haystack-v1-implementation-plan.md. The redirect puts the whole path and
// query into `return_to` with encodeURIComponent, so every character that is already encoded
// grows again: "%" becomes "%25", and the "+" that stands for a space becomes "%2B".
import {
  CAPTURE_CAPS,
  type CaptureField,
  SAVE_URL_BUDGET,
  validateCapturePayload,
} from "@haystack/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

// Cloudflare's "Request and response limits" table on
// https://developers.cloudflare.com/workers/platform/limits/ gives the URL size as "16 KB". The
// page does not say whether a KB is 1,000 or 1,024 bytes, so the test holds the redirect to the
// smaller 16,000.
const CLOUDFLARE_URL_LIMIT = 16_000;

// The origin the extension is built with. The budget counts it, and a browser resolves the
// redirect against it.
const ORIGIN = "https://haystack.example";

const server = createTestHarness({
  workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

function query(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

// The save URL as the extension builds it, with the origin and `/save?` counted.
function saveUrlLength(fields: Record<string, string>): number {
  return `${ORIGIN}/save?${query(fields)}`.length;
}

// An address of `units` code units. Each "/" is encoded to "%2F" in the save URL, which the
// redirect encodes again to "%252F".
function address(units: number, scheme = "https"): string {
  const prefix = `${scheme}://example.com/`;
  return prefix + "/".repeat(units - prefix.length);
}

// An http address that is `characters` long once the save URL encodes it.
function addressEncodedTo(characters: number): string {
  const prefix = "http://example.com/";
  const rest = characters - query({ a: prefix }).length + "a=".length;
  return prefix + "/".repeat(Math.floor(rest / 3)) + "a".repeat(rest % 3);
}

// Text of `units` code units that is mostly spaces, which a query writes as "+", one character
// that the redirect encodes to three ("%2B"). It starts and ends with a letter, so trimming
// keeps all of it.
function spaced(units: number): string {
  return `a${" ".repeat(units - 2)}a`;
}

// The longest payload the caps and the budget allow, with the address and the canonical URL at
// the sizes that leave the most room for the characters that grow most. The canonical URL takes
// whatever is left of the budget, so the save URL is exactly SAVE_URL_BUDGET characters.
function payloadAtBudget(text: Partial<Record<CaptureField, string>>): Record<string, string> {
  const withoutCanonical = { url: address(CAPTURE_CAPS.url), ...text };
  const room = SAVE_URL_BUDGET - saveUrlLength({ ...withoutCanonical, canonical_url: "" });
  const canonical = addressEncodedTo(room);
  return { ...withoutCanonical, canonical_url: canonical };
}

const cases = [
  {
    name: "an address and a canonical URL made of characters that percent-encode",
    fields: payloadAtBudget({}),
  },
  {
    name: "the same, with every text field full of spaces",
    fields: payloadAtBudget({
      title: spaced(CAPTURE_CAPS.title),
      description: spaced(CAPTURE_CAPS.description),
      og_title: spaced(CAPTURE_CAPS.og_title),
      og_description: spaced(CAPTURE_CAPS.og_description),
      og_site_name: spaced(CAPTURE_CAPS.og_site_name),
    }),
  },
];

describe("a save URL at the budget", () => {
  it.each(cases)("is a valid payload that fills the budget exactly: $name", ({ fields }) => {
    expect(validateCapturePayload(fields).ok).toBe(true);
    expect(saveUrlLength(fields)).toBe(SAVE_URL_BUDGET);
  });

  it.each(cases)(
    "still redirects to a sign-in URL under Cloudflare's limit: $name",
    async ({ fields }) => {
      const path = `/save?${query(fields)}`;

      const response = await server.fetch(path, {
        headers: { accept: "text/html" },
        redirect: "manual",
      });

      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location).toBe(`/auth/sign-in?return_to=${encodeURIComponent(path)}`);
      // The browser resolves the Location against the origin it asked, so this is the full URL
      // it requests next. The sign-in then keeps the return target in D1, not in a URL.
      const requested = new URL(location, ORIGIN);
      expect(requested.href.length).toBeLessThan(CLOUDFLARE_URL_LIMIT);
      expect(requested.searchParams.get("return_to")).toBe(path);
    },
  );
});
