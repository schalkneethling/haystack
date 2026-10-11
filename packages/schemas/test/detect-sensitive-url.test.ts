import { describe, expect, it } from "vite-plus/test";
import {
  CREDENTIAL_PARAMETERS,
  detectSensitiveUrl,
  SIGNED_STORAGE_PARAMETERS,
  type SensitiveUrlReason,
} from "../src/index.ts";

function detect(url: string): SensitiveUrlReason | undefined {
  return detectSensitiveUrl(new URL(url));
}

// Each name in its listed form, in uppercase, and in mixed case.
function caseVariants(name: string): string[] {
  // The names are ASCII, so each UTF-16 code unit is one character.
  const mixed = name.replace(/./g, (char, i: number) => (i % 2 === 0 ? char.toUpperCase() : char));
  return [name, name.toUpperCase(), mixed];
}

// Where a parameter can appear: the query string, the fragment, and a hash route's query.
const placements: [string, (param: string) => string][] = [
  ["query", (param) => `https://example.com/file?${param}`],
  ["fragment", (param) => `https://example.com/callback#${param}`],
  ["hash route", (param) => `https://example.com/#/callback?${param}`],
];

describe("detectSensitiveUrl", () => {
  describe.each(placements)("in the %s", (_, build) => {
    it.each([...SIGNED_STORAGE_PARAMETERS].flatMap(caseVariants))(
      "detects %s as a signed storage URL",
      (name) => {
        expect(detect(build(`${name}=abc123&other=1`))).toBe("signed-storage-url");
      },
    );

    it.each([...caseVariants("sig").map((sig) => [sig, "se"]), ["sig", "SE"]])(
      "detects Azure SAS (%s with %s)",
      (sig, se) => {
        expect(detect(build(`sv=2024-01-01&${se}=2026-10-11&${sig}=abc123`))).toBe(
          "signed-storage-url",
        );
      },
    );

    it.each([...CREDENTIAL_PARAMETERS].flatMap(caseVariants))(
      "detects %s as a credential parameter",
      (name) => {
        expect(detect(build(`${name}=abc123`))).toBe("credential-parameter");
      },
    );
  });

  it("detects an S3 pre-signed URL", () => {
    expect(
      detect(
        "https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261011&X-Amz-Expires=3600&X-Amz-Signature=abc",
      ),
    ).toBe("signed-storage-url");
  });

  it.each([
    ["a username and password", "https://user:secret@example.com/"],
    ["a username only", "https://user@example.com/"],
    ["a password only", "https://:secret@example.com/"],
  ])("detects embedded credentials with %s", (_, url) => {
    expect(detect(url)).toBe("embedded-credentials");
  });

  it.each([
    ["documentation with a token parameter", "https://docs.example.com/api?token=jwt"],
    ["documentation with a code parameter", "https://docs.example.com/oauth?code=example"],
    ["an OAuth guide", "https://example.com/guide?response_type=code&client_id=abc"],
    ["sig without se", "https://example.com/forum?sig=on"],
    ["se without sig", "https://example.com/search?se=books"],
    ["a credential word in the path", "https://example.com/password-reset-guide"],
    ["a credential name as a value", "https://example.com/docs?param=access_token"],
    ["a credential name as part of a longer name", "https://example.com/docs?access_token_docs=1"],
    ["a fragment that is a heading id", "https://example.com/docs#access-token"],
    ["an ordinary URL", "https://example.com/article?page=2#comments"],
  ])("accepts %s", (_, url) => {
    expect(detect(url)).toBeUndefined();
  });
});
