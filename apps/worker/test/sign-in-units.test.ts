import { describe, expect, it } from "vite-plus/test";
import {
  allowsInsecureRequests,
  authorizationUrl,
  completeSignIn,
  type GoogleConfig,
} from "../src/auth/google.ts";
import { safeReturnTarget } from "../src/auth/return-target.ts";

describe("safeReturnTarget", () => {
  it.each([
    ["/", "/"],
    ["/save?url=https%3A%2F%2Fexample.com%2F", "/save?url=https%3A%2F%2Fexample.com%2F"],
    ["/a/b?c=1#d", "/a/b?c=1#d"],
  ])("keeps the path %j", (value, expected) => {
    expect(safeReturnTarget(value)).toBe(expected);
  });

  it.each([
    ["no value", null],
    ["an absolute URL", "https://evil.example/"],
    ["a protocol-relative URL", "//evil.example/"],
    ["a backslash after the slash", "/\\evil.example/"],
    ["a tab the parser removes", "/\t/evil.example/"],
    ["a newline the parser removes", "/\n/evil.example/"],
    ["a relative path", "save"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["an empty string", ""],
    ["a dot segment before //", "/.//evil.example/"],
    ["a parent segment before //", "/a/..//evil.example/"],
    ["an encoded parent segment before //", "/%2e%2e//evil.example/"],
    ["a dot segment before a backslash", "/.\\/evil.example/"],
  ])("falls back to / for %s", (_, value) => {
    expect(safeReturnTarget(value)).toBe("/");
  });

  it.each(["/a/b?c=1#d", "/.//evil.example/", "/a/../b", "https://evil.example/", "/%2F%2Fevil"])(
    "gives a result that is unchanged when applied again (%j)",
    (value) => {
      const once = safeReturnTarget(value);
      expect(safeReturnTarget(once)).toBe(once);
    },
  );
});

describe("completeSignIn", () => {
  const config = (tokenEndpoint: string, jwksUri: string): GoogleConfig => ({
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_ISSUER: "https://accounts.google.com",
    GOOGLE_AUTHORIZATION_ENDPOINT: "https://accounts.google.com/o/oauth2/v2/auth",
    GOOGLE_TOKEN_ENDPOINT: tokenEndpoint,
    GOOGLE_JWKS_URI: jwksUri,
  });
  const callbackUrl = new URL("https://haystack.example/auth/callback?code=c&state=s");

  it.each([
    ["https everywhere", "https://oauth.example/token", "https://oauth.example/jwks", false],
    ["http on 127.0.0.1", "http://127.0.0.1:1/token", "http://127.0.0.1:1/jwks", true],
    ["http on localhost", "http://localhost:1/token", "https://oauth.example/jwks", true],
    ["http on [::1]", "https://oauth.example/token", "http://[::1]:1/jwks", true],
    [
      "http token endpoint elsewhere",
      "http://oauth.example/token",
      "https://oauth.example/jwks",
      false,
    ],
    [
      "http keys endpoint elsewhere",
      "https://oauth.example/token",
      "http://oauth.example/jwks",
      false,
    ],
    [
      "http elsewhere and on loopback",
      "http://127.0.0.1:1/token",
      "http://oauth.example/jwks",
      false,
    ],
  ])("allows insecure requests with %s: %s", (_, token, jwks, expected) => {
    expect(allowsInsecureRequests(config(token, jwks))).toBe(expected);
  });

  it.each([
    ["https", "https://accounts.google.com/o/oauth2/v2/auth", true],
    ["http on loopback", "http://127.0.0.1:1/authorize", true],
    ["http elsewhere", "http://accounts.example/authorize", false],
  ])("builds an authorization URL for a %s endpoint: %s", (_, endpoint, allowed) => {
    const endpoints = config("https://oauth.example/token", "https://oauth.example/jwks");
    const build = () =>
      authorizationUrl(
        { ...endpoints, GOOGLE_AUTHORIZATION_ENDPOINT: endpoint },
        "https://haystack.example/auth/callback",
        "state",
        "challenge",
      );
    if (allowed) {
      expect(new URL(build()).searchParams.get("state")).toBe("state");
    } else {
      expect(build).toThrow(/https/);
    }
  });

  it("refuses an http: token endpoint on a host that is not loopback, before any request", async () => {
    await expect(
      completeSignIn(
        config("http://oauth.example/token", "https://oauth.example/jwks"),
        callbackUrl,
        "s",
        "verifier",
        "https://haystack.example/auth/callback",
      ),
    ).rejects.toThrow(/https/i);
  });

  it.each([
    ["an empty string", ""],
    ["a missing value", undefined as unknown as string],
  ])(
    "refuses %s as the client secret, with a code that names it, before any request",
    async (_, secret) => {
      const error = await completeSignIn(
        {
          ...config("https://oauth.example/token", "https://oauth.example/jwks"),
          GOOGLE_CLIENT_SECRET: secret,
        },
        callbackUrl,
        "s",
        "verifier",
        "https://haystack.example/auth/callback",
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "GOOGLE_CLIENT_SECRET_EMPTY" });
    },
  );
});
