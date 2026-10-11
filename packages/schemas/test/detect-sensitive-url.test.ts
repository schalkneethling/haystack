import { describe, expect, it } from "vite-plus/test";
import {
  AZURE_SAS_PARAMETERS,
  CREDENTIAL_PARAMETERS,
  detectSensitiveUrl,
  SIGNED_STORAGE_PARAMETERS,
  type SensitiveUrlReason,
} from "../src/index.ts";

function detect(url: string): SensitiveUrlReason | undefined {
  return detectSensitiveUrl(new URL(url));
}

// Written out, not read from the exported lists: removing a signal must fail a test.
const SIGNED_STORAGE_LIST = ["x-amz-signature", "x-amz-credential", "x-goog-signature"];
const CREDENTIAL_LIST = [
  "access_token",
  "id_token",
  "refresh_token",
  "api_key",
  "apikey",
  "password",
  "client_secret",
];

// Each name in its listed form, in uppercase, and in mixed case.
function caseVariants(name: string): string[] {
  // The names are ASCII, so each UTF-16 code unit is one character.
  const mixed = name.replace(/./g, (char, i: number) => (i % 2 === 0 ? char.toUpperCase() : char));
  return [name, name.toUpperCase(), mixed];
}

// Credential parameters can appear in the query string, the fragment, and a hash route's query.
const credentialPlacements: [string, (param: string) => string][] = [
  ["query", (param) => `https://example.com/file?${param}`],
  ["fragment", (param) => `https://example.com/callback#${param}`],
  ["hash route", (param) => `https://example.com/#/callback?${param}`],
];

describe("detectSensitiveUrl", () => {
  it("exports exactly the signals listed in this test", () => {
    expect(SIGNED_STORAGE_PARAMETERS).toEqual(SIGNED_STORAGE_LIST);
    expect(AZURE_SAS_PARAMETERS).toEqual(["sig", "se"]);
    expect(CREDENTIAL_PARAMETERS).toEqual(CREDENTIAL_LIST);
  });

  it("does not let importers change the lists", () => {
    expect(Object.isFrozen(SIGNED_STORAGE_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(AZURE_SAS_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(CREDENTIAL_PARAMETERS)).toBe(true);
  });

  it.each(SIGNED_STORAGE_LIST.flatMap(caseVariants))(
    "detects %s in the query as a signed storage URL",
    (name) => {
      expect(detect(`https://example.com/file?${name}=abc123&other=1`)).toBe("signed-storage-url");
    },
  );

  const [sigName, seName] = AZURE_SAS_PARAMETERS;
  it.each(caseVariants(sigName).flatMap((sig) => caseVariants(seName).map((se) => [sig, se])))(
    "detects Azure SAS (%s with %s) in the query",
    (sig, se) => {
      expect(detect(`https://example.com/f?sv=2024-01-01&${se}=2026-10-11&${sig}=abc`)).toBe(
        "signed-storage-url",
      );
    },
  );

  describe.each(credentialPlacements)("in the %s", (_, build) => {
    it.each(CREDENTIAL_LIST.flatMap(caseVariants))(
      "detects %s as a credential parameter",
      (name) => {
        expect(detect(build(`${name}=abc123`))).toBe("credential-parameter");
      },
    );

    it.each(CREDENTIAL_LIST)("accepts %s without a value", (name) => {
      expect(detect(build(`${name}=`))).toBeUndefined();
      expect(detect(build(name))).toBeUndefined();
    });
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
    ["a heading anchor named like a credential", "https://docs.example.com/oauth#access_token"],
    ["a heading anchor named like an API key", "https://docs.example.com/config#api_key"],
    ["a bare password parameter", "https://example.com/docs?password"],
    ["a storage signature name in the fragment", "https://example.com/docs#x-amz-signature=abc"],
    ["Azure SAS names split across query and fragment", "https://example.com/?sig=on#se=x"],
    ["Azure SAS names in the fragment", "https://example.com/#sig=a&se=b"],
    ["an ordinary URL", "https://example.com/article?page=2#comments"],
  ])("accepts %s", (_, url) => {
    expect(detect(url)).toBeUndefined();
  });
});
