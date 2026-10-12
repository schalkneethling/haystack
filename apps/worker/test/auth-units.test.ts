import { describe, expect, it } from "vite-plus/test";
import { isEmailAllowed, parseAllowedEmails } from "../src/auth/allowlist.ts";
import {
  readSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "../src/auth/cookie.ts";
import {
  generateSessionId,
  hashSessionId,
  SESSION_LIFETIME_MS,
  shouldExtendSession,
} from "../src/auth/session-token.ts";

describe("parseAllowedEmails", () => {
  it("trims, lowercases, and drops empty entries", () => {
    expect([...parseAllowedEmails(" A@Example.com, ,b@example.com,")]).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("allows nobody when empty", () => {
    expect(isEmailAllowed(parseAllowedEmails(""), "a@example.com")).toBe(false);
  });

  it("matches without regard to case or surrounding whitespace", () => {
    expect(isEmailAllowed(parseAllowedEmails("a@example.com"), " A@EXAMPLE.com ")).toBe(true);
  });

  it("does not fold non-ASCII characters into ASCII", () => {
    // U+212A KELVIN SIGN lowercases to "k" with toLowerCase().
    expect(isEmailAllowed(parseAllowedEmails("kate@example.com"), "\u212Aate@example.com")).toBe(
      false,
    );
  });

  it("does not match a different address", () => {
    expect(isEmailAllowed(parseAllowedEmails("a@example.com"), "a@example.co")).toBe(false);
  });
});

describe("session cookie", () => {
  it("serializes every required attribute", () => {
    expect(serializeSessionCookie("abc", 60)).toBe(
      "__Host-session=abc; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("clears with an empty value and Max-Age=0", () => {
    expect(serializeClearedSessionCookie()).toBe(
      "__Host-session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it.each([
    ["a missing header", null, undefined],
    ["no session cookie", "a=1; b=2", undefined],
    ["an empty value", "__Host-session=", undefined],
    ["the session cookie among others", "a=1; __Host-session=xyz; b=2", "xyz"],
    ["a cookie whose name only ends the same way", "x__Host-session=no", undefined],
  ])("reads %s", (_, header, expected) => {
    expect(readSessionCookie(header)).toBe(expected);
  });
});

describe("session tokens", () => {
  it("generates 32 random bytes as base64url", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionId()).not.toBe(id);
  });

  it("hashes with SHA-256 as hex", async () => {
    expect(await hashSessionId("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it.each([
    ["at the start of its life", SESSION_LIFETIME_MS, false],
    ["at the midpoint", SESSION_LIFETIME_MS / 2, false],
    ["just after the midpoint", SESSION_LIFETIME_MS / 2 - 1, true],
    ["near expiry", 1000, true],
  ])("extends a session %s: %s", (_, remaining, expected) => {
    const now = 1_000_000;
    expect(shouldExtendSession(now + remaining, now)).toBe(expected);
  });
});
